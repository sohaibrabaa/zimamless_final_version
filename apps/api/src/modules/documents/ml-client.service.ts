import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/configuration';

/**
 * Client for the Python ML service (`/services/ml`).
 *
 * The service is treated as fallible infrastructure, not as a library call.
 * It is a separate process that can be down, slow, or mid-restart, and an
 * invoice upload must not fail because OCR was unavailable — the document is
 * stored and hashed regardless, and an absent extraction routes the
 * transaction to manual review, which is a supported outcome.
 *
 * That is the same posture the government adapters take, and for the same
 * reason: an unavailable service is an absence of information, never an
 * adverse finding about the supplier.
 */

export interface MlExtractionField {
  [field: string]: string;
}

export interface MlExtraction {
  documentSha256: string;
  sizeBytes: number;
  pageCount: number;
  engineVersion: string;
  ocr: {
    available: boolean;
    rawOutput: Record<string, unknown>;
    extractedFields: MlExtractionField;
    confidence: number;
    rejectedFields: MlExtractionField;
    unavailableReason: string | null;
  };
  qr: {
    parsed: boolean;
    validationStatus: 'VALID' | 'INVALID' | 'UNPARSED' | 'UNAVAILABLE';
    schemaName: string | null;
    rawOutput: Record<string, unknown>;
    extractedFields: MlExtractionField;
    rejectedFields: MlExtractionField;
  };
  mismatches: { field: string; ocrValue: string; qrValue: string }[];
  /** Set by this client, not the service: the call itself did not complete. */
  serviceAvailable: boolean;
}

@Injectable()
export class MlClientService {
  private readonly logger = new Logger(MlClientService.name);

  constructor(private readonly config: AppConfig) {}

  /**
   * Extract from a document's bytes.
   *
   * Never throws. A transport failure returns a result shaped exactly like
   * a successful one with everything degraded — so callers have a single
   * code path and cannot forget to handle the down case, which is the
   * failure mode a thrown exception invites.
   */
  async extract(data: Buffer, fileName: string, mimeType: string): Promise<MlExtraction> {
    const url = `${this.config.ml.url.replace(/\/+$/, '')}/extract`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.extractionTimeoutMs);

    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), fileName);
      form.append('contentType', mimeType);

      const response = await fetch(url, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.warn(`ML service returned ${response.status} for ${fileName}: ${detail}`);
        return this.unavailable(data, `The extraction service returned ${response.status}.`);
      }

      const body = (await response.json()) as Omit<MlExtraction, 'serviceAvailable'>;
      return { ...body, serviceAvailable: true };
    } catch (err) {
      const message = (err as Error).name === 'AbortError'
        ? `The extraction service did not respond within ${this.extractionTimeoutMs}ms.`
        : `The extraction service could not be reached: ${(err as Error).message}`;
      this.logger.warn(message);
      return this.unavailable(data, message);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Longer than the configured government timeout: rasterizing a PDF and
   * running OCR over it is genuinely slow work, and a five-second budget
   * would report the service as down while it was busy succeeding.
   */
  private get extractionTimeoutMs(): number {
    const configured = Number.parseInt(process.env.ML_EXTRACTION_TIMEOUT_MS ?? '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  }

  /**
   * The degraded shape.
   *
   * `UNPARSED` rather than `UNAVAILABLE` for the QR: from the platform's
   * point of view a document it never managed to examine is a document
   * whose code has not been read, and marking it UNAVAILABLE would assert
   * that we looked and found no code there.
   */
  private unavailable(data: Buffer, reason: string): MlExtraction {
    return {
      documentSha256: '',
      sizeBytes: data.length,
      pageCount: 0,
      engineVersion: 'unavailable',
      ocr: {
        available: false,
        rawOutput: { error: reason },
        extractedFields: {},
        confidence: 0,
        rejectedFields: {},
        unavailableReason: reason,
      },
      qr: {
        parsed: false,
        validationStatus: 'UNPARSED',
        schemaName: null,
        rawOutput: { error: reason },
        extractedFields: {},
        rejectedFields: {},
      },
      mismatches: [],
      serviceAvailable: false,
    };
  }

  async health(): Promise<{ reachable: boolean; ocrEngineAvailable: boolean }> {
    try {
      const response = await fetch(`${this.config.ml.url.replace(/\/+$/, '')}/health`, {
        signal: AbortSignal.timeout(this.config.ml.timeoutMs),
      });
      if (!response.ok) return { reachable: false, ocrEngineAvailable: false };
      const body = (await response.json()) as { ocrEngineAvailable?: boolean };
      return { reachable: true, ocrEngineAvailable: body.ocrEngineAvailable === true };
    } catch {
      return { reachable: false, ocrEngineAvailable: false };
    }
  }
}
