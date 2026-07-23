import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { plusSeconds } from '../../common/time/business-time';

/**
 * Supabase Storage, reached over its REST API with the service-role key.
 *
 * Hard rule 8: the service-role key never leaves the server. That is why
 * this class exists at all — the browser is given a *signed URL* scoped to
 * one object and a few minutes, never a credential. A client holding the
 * service key could read every document belonging to every organization on
 * the platform, so the boundary is worth a whole file.
 *
 * The bucket is private. `ZM-DOC-004` requires access "by short-lived signed
 * URL issued only after a server-side authorization check", and a public
 * bucket would make the authorization check decorative: anyone who learned
 * a path could fetch the object without ever touching this API.
 *
 * The Phase 3 kickoff flagged this surface specifically — it is the most
 * Supabase-coupled thing the project has built, and the JWT/GoTrue lesson
 * from Phase 1 is that storage behaviour is unverified until it has been
 * exercised against the hosted project.
 */

/** Signed upload/download URLs are deliberately short-lived (ZM-DOC-004). */
export const UPLOAD_URL_TTL_SECONDS = 300; // 5 minutes to start an upload
export const DOWNLOAD_URL_TTL_SECONDS = 120; // 2 minutes to fetch one object

export interface SignedUpload {
  path: string;
  signedUrl: string;
  token: string;
  expiresAt: Date;
}

export interface SignedDownload {
  signedUrl: string;
  expiresAt: Date;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly bucket: string;

  constructor(
    private readonly config: AppConfig,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {
    this.bucket = process.env.SUPABASE_DOCUMENTS_BUCKET?.trim() || 'documents';
  }

  /**
   * When a signed URL we are about to issue will stop working.
   *
   * Goes through TimeProvider like every other clock read in `modules/**`
   * (hard rule 4). Supabase enforces the real TTL against its own clock, so
   * with the demo time machine running this reported expiry carries the
   * demo offset while the URL itself expires in real minutes. That is the
   * right trade: the time machine is forbidden in production, and inside a
   * demo an expiry stamped in real time would be the one date on screen
   * disagreeing with every other one.
   */
  private expiryFrom(seconds: number): Date {
    return plusSeconds(this.time.now(), seconds);
  }

  private get baseUrl(): string {
    return `${this.config.supabase.url.replace(/\/+$/, '')}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.config.supabase.serviceRoleKey,
      Authorization: `Bearer ${this.config.supabase.serviceRoleKey}`,
      ...extra,
    };
  }

  /**
   * Create the private bucket if it is absent.
   *
   * Idempotent, and safe to call at boot. Storage is infrastructure the API
   * cannot function without, and discovering it is missing on a supplier's
   * first upload — in front of a judge — is strictly worse than discovering
   * it at startup.
   */
  async ensureBucket(): Promise<void> {
    const existing = await fetch(`${this.baseUrl}/bucket/${this.bucket}`, {
      headers: this.headers(),
    });
    if (existing.ok) return;

    const created = await fetch(`${this.baseUrl}/bucket`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        id: this.bucket,
        name: this.bucket,
        // Never public. See the class comment.
        public: false,
        file_size_limit: MAX_DOCUMENT_BYTES,
        allowed_mime_types: [...ALLOWED_MIME_TYPES],
      }),
    });

    if (!created.ok && created.status !== 409) {
      const detail = await created.text();
      throw new Error(`Failed to create the "${this.bucket}" storage bucket: ${detail}`);
    }
    this.logger.log(`Storage bucket "${this.bucket}" is present and private.`);
  }

  /**
   * The object key for a document.
   *
   * Organization-prefixed so a stray listing is at least tenant-scoped, and
   * uuid-named so the key leaks nothing about the file. Using the supplier's
   * original file name as the key would put "Al-Noor invoice for Levant
   * Construction.pdf" into a URL and into every log line that records one.
   */
  pathFor(organizationId: string, documentId: string, fileName: string): string {
    const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : 'bin';
    const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
    return `${organizationId}/${documentId}.${safeExtension}`;
  }

  /** A signed URL the browser can PUT the file to, and nothing else. */
  async createSignedUpload(path: string): Promise<SignedUpload> {
    const response = await fetch(`${this.baseUrl}/object/upload/sign/${this.bucket}/${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: UPLOAD_URL_TTL_SECONDS }),
    });
    if (!response.ok) {
      throw await this.storageFailure('issue an upload URL', response);
    }
    const body = (await response.json()) as { url?: string; token?: string };
    if (!body.url) throw new Error('Supabase Storage returned no signed upload URL.');

    return {
      path,
      signedUrl: this.absolute(body.url),
      token: body.token ?? '',
      expiresAt: this.expiryFrom(UPLOAD_URL_TTL_SECONDS),
    };
  }

  /** A signed URL for one object, valid for a couple of minutes. */
  async createSignedDownload(path: string): Promise<SignedDownload> {
    const response = await fetch(`${this.baseUrl}/object/sign/${this.bucket}/${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: DOWNLOAD_URL_TTL_SECONDS }),
    });
    if (!response.ok) {
      throw await this.storageFailure('issue a download URL', response);
    }
    const body = (await response.json()) as { signedURL?: string; signedUrl?: string };
    const url = body.signedURL ?? body.signedUrl;
    if (!url) throw new Error('Supabase Storage returned no signed download URL.');

    return {
      signedUrl: this.absolute(url),
      expiresAt: this.expiryFrom(DOWNLOAD_URL_TTL_SECONDS),
    };
  }

  /** Fetch an object's bytes server-side, for hashing and extraction. */
  async download(path: string): Promise<Buffer | null> {
    const response = await fetch(`${this.baseUrl}/object/${this.bucket}/${path}`, {
      headers: this.headers(),
    });
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) {
      throw await this.storageFailure('download an object', response);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** Upload bytes directly. Used by the seed tooling, not by request paths. */
  async upload(path: string, data: Buffer, contentType: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/object/${this.bucket}/${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': contentType, 'x-upsert': 'true' }),
      body: new Uint8Array(data),
    });
    if (!response.ok) {
      throw await this.storageFailure('upload an object', response);
    }
  }

  async exists(path: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/object/info/${this.bucket}/${path}`, {
      headers: this.headers(),
    });
    return response.ok;
  }

  /**
   * Supabase returns signed URLs relative to /storage/v1. Returning a
   * relative URL to a browser on a different origin would simply 404 there,
   * so it is absolutized here rather than in each caller.
   */
  private absolute(url: string): string {
    if (/^https?:\/\//.test(url)) return url;
    return `${this.baseUrl}/${url.replace(/^\/+/, '')}`;
  }

  private async storageFailure(action: string, response: Response): Promise<AppException> {
    const detail = await response.text().catch(() => '');
    this.logger.error(`Storage failed to ${action}: ${response.status} ${detail}`);
    // The storage detail is logged, never returned: it can name internal
    // paths and bucket configuration.
    return new AppException(
      ErrorCode.SERVICE_UNAVAILABLE,
      'Document storage is temporarily unavailable. Please try again shortly.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/** 20 MB. An invoice is a few hundred kilobytes; this is generous. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * Accepted upload types.
 *
 * An allow-list rather than a deny-list: the set of things a supplier
 * legitimately uploads is small and knowable, while the set of things that
 * should not be in a document store is not.
 */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
];
