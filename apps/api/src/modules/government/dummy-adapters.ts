import { Injectable } from '@nestjs/common';
import {
  AnsweredResult,
  GovSource,
  GovernmentAdapter,
  GovernmentLookupResult,
} from './government-adapter';
import {
  RegistryEntity,
  SourceBehaviour,
  injectedFailureFor,
  lookupRegistry,
} from './dummy-registry';

/**
 * Dummy CCD / ISTD / GAM adapters.
 *
 * V3 has no live registry integrations; these stand in for them and are the
 * only implementation the platform will see this phase. They are written as
 * if the real thing were behind them — same union result, same field keys,
 * same provenance — so swapping in an HTTP client later changes this file
 * and nothing downstream.
 *
 * Everything is deterministic by establishment number. A test that says
 * "the registry is down" must mean it every time it runs, which is what the
 * 9000xxxx keys in GOV_DUMMY_DATA §5 provide.
 */

/** Field keys each source is expected to supply — the availability denominator. */
export const CCD_FIELDS = [
  'legalNameEn',
  'legalNameAr',
  'companyType',
  'registryStatus',
  'commercialRegistrationNo',
  'registrationDate',
  'paidCapitalJod',
  'governorate',
] as const;

export const ISTD_FIELDS = [
  'taxNumber',
  'taxStatus',
  'vatRegistered',
  'lastFilingPeriod',
] as const;

export const GAM_FIELDS = [
  'professionLicenceNumber',
  'licenceStatus',
  'licenceExpiryDate',
  'premisesAddress',
  'activityCode',
] as const;

/**
 * Simulated latency per source, in milliseconds.
 *
 * Real registry calls are slow and the UI has to look right waiting for
 * them, so the dummies are slow too. Disabled under NODE_ENV=test: a suite
 * that sleeps for realism is a suite people stop running.
 */
const BASE_LATENCY_MS: Record<GovSource, number> = {
  CCD: 400,
  ISTD: 550,
  GAM: 350,
  EINVOICE: 300,
};

function latencyEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.ZM_GOV_LATENCY !== 'off';
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves what a source should do for a key: an injected failure first,
 * then the identity's per-source behaviour, then "not found".
 *
 * An unknown number returning NOT_FOUND rather than UNAVAILABLE is
 * deliberate and is the same distinction hard rule 7 draws: the registry
 * was reachable and reported no such entity.
 */
function resolveBehaviour(
  source: GovSource,
  lookupKey: string,
): { behaviour: SourceBehaviour; entity: RegistryEntity | null; delayMs: number; httpError: boolean } {
  const injected = injectedFailureFor(lookupKey);
  if (injected) {
    const record = lookupRegistry('20000101'); // stand-in payload for shape
    return {
      behaviour: injected.behaviour,
      entity: record ? record.entity : null,
      delayMs: injected.delayMs ?? BASE_LATENCY_MS[source],
      httpError: injected.httpError ?? false,
    };
  }

  const record = lookupRegistry(lookupKey);
  if (!record) {
    return { behaviour: 'NOT_FOUND', entity: null, delayMs: BASE_LATENCY_MS[source], httpError: false };
  }
  return {
    behaviour: record.behaviour[source] ?? 'FULL',
    entity: record.entity,
    delayMs: BASE_LATENCY_MS[source],
    httpError: false,
  };
}

/**
 * Builds the answered result, dropping half the fields for PARTIAL.
 *
 * Which half is chosen by position rather than at random: a partial answer
 * has to be the same partial answer on every run or `dataAvailabilityPct`
 * becomes untestable.
 */
function answer(
  fields: readonly string[],
  full: Record<string, string>,
  behaviour: SourceBehaviour,
  raw: Record<string, unknown>,
): AnsweredResult {
  if (behaviour === 'NOT_FOUND') {
    return { kind: 'ANSWERED', status: 'NOT_FOUND', raw: {}, normalized: {}, expectedFields: fields };
  }
  if (behaviour === 'PARTIAL') {
    const keep = fields.slice(0, Math.ceil(fields.length / 2));
    const normalized: Record<string, string> = {};
    for (const key of keep) if (full[key] !== undefined) normalized[key] = full[key];
    const partialRaw: Record<string, unknown> = {};
    for (const key of keep) if (raw[key] !== undefined) partialRaw[key] = raw[key];
    return {
      kind: 'ANSWERED',
      status: 'PARTIAL',
      raw: partialRaw,
      normalized,
      expectedFields: fields,
    };
  }
  return { kind: 'ANSWERED', status: 'SUCCESS', raw, normalized: full, expectedFields: fields };
}

abstract class DummyAdapterBase implements GovernmentAdapter {
  abstract readonly source: GovSource;
  readonly version = 'dummy-1.0.0';

  protected abstract fields(): readonly string[];
  protected abstract project(entity: RegistryEntity): Record<string, string>;

  async lookup(lookupKey: string): Promise<GovernmentLookupResult> {
    const resolved = resolveBehaviour(this.source, lookupKey);
    if (latencyEnabled()) await sleep(resolved.delayMs);

    // An HTTP-level failure from the source: no answer at all.
    if (resolved.httpError) {
      return {
        kind: 'UNANSWERED',
        status: 'ERROR',
        errorCode: 'SOURCE_HTTP_500',
        errorMessage: `${this.source} returned HTTP 500.`,
      };
    }

    if (resolved.behaviour === 'UNAVAILABLE') {
      return {
        kind: 'UNANSWERED',
        status: 'UNAVAILABLE',
        errorCode: 'SOURCE_UNAVAILABLE',
        errorMessage: `${this.source} did not respond.`,
      };
    }

    if (!resolved.entity || resolved.behaviour === 'NOT_FOUND') {
      // The registry answered: no such entity. Adverse, but an answer.
      return answer(this.fields(), {}, 'NOT_FOUND', {});
    }

    const projected = this.project(resolved.entity);
    return answer(this.fields(), projected, resolved.behaviour, this.rawOf(resolved.entity, projected));
  }

  /**
   * The "verbatim" payload. A real source returns its own field names and
   * casing; keeping the normalized mapping separate from this is what makes
   * `government_data_snapshots.raw_payload` worth storing at all.
   */
  protected rawOf(entity: RegistryEntity, projected: Record<string, string>): Record<string, unknown> {
    return {
      source_system: this.source,
      queried_establishment_no: entity.establishmentNumber,
      record: projected,
    };
  }
}

@Injectable()
export class CcdAdapter extends DummyAdapterBase {
  readonly source: GovSource = 'CCD';
  protected fields(): readonly string[] {
    return CCD_FIELDS;
  }
  protected project(e: RegistryEntity): Record<string, string> {
    return {
      legalNameEn: e.legalNameEn,
      legalNameAr: e.legalNameAr,
      companyType: e.companyType,
      registryStatus: e.registryStatus,
      commercialRegistrationNo: e.commercialRegistrationNo,
      registrationDate: e.registrationDate,
      // Money crosses this boundary as a 3-dp string and stays one. There is
      // no float in the adapter path at all.
      paidCapitalJod: e.paidCapitalJod,
      governorate: e.governorate,
    };
  }
}

@Injectable()
export class IstdAdapter extends DummyAdapterBase {
  readonly source: GovSource = 'ISTD';
  protected fields(): readonly string[] {
    return ISTD_FIELDS;
  }
  protected project(e: RegistryEntity): Record<string, string> {
    return {
      taxNumber: e.taxNumber,
      taxStatus: e.taxStatus,
      vatRegistered: String(e.vatRegistered),
      lastFilingPeriod: e.lastFilingPeriod,
    };
  }
}

@Injectable()
export class GamAdapter extends DummyAdapterBase {
  readonly source: GovSource = 'GAM';
  protected fields(): readonly string[] {
    return GAM_FIELDS;
  }
  protected project(e: RegistryEntity): Record<string, string> {
    return {
      professionLicenceNumber: e.professionLicenceNumber,
      licenceStatus: e.licenceStatus,
      licenceExpiryDate: e.licenceExpiryDate,
      premisesAddress: e.premisesAddress,
      activityCode: e.activityCode,
    };
  }
}
