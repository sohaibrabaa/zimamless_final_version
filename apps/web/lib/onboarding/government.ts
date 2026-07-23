/**
 * Adapter for the free-form `SupplierApplication.governmentData` object.
 *
 * The frozen contract types it `additionalProperties: true`; the shape the
 * server actually sends — settled by the Phase 2 unification session, closing
 * **Q-05** — is one entry per field:
 *
 *   { value, sourceKind, source, retrievedAt }
 *
 * with `sourceKind ∈ GOVERNMENT | SELF_DECLARED | DERIVED` (DB enum
 * `data_source_kind`) and `source ∈ CCD | ISTD | GAM | EINVOICE` for
 * GOVERNMENT rows, null for SELF_DECLARED.
 *
 * This module remains the ONLY place that knows the payload shape. It accepts
 * that shape, degrades to a value-only (badge-less) render for anything else,
 * and never throws on unexpected input.
 */

export const GOVERNMENT_SOURCES = ["CCD", "ISTD", "GAM", "EINVOICE"] as const;
export type GovernmentSource = (typeof GOVERNMENT_SOURCES)[number];

export function isGovernmentSource(value: unknown): value is GovernmentSource {
  return typeof value === "string" && (GOVERNMENT_SOURCES as readonly string[]).includes(value);
}

/** ZM-SON-004: government values and self-declared values coexist; neither overwrites the other. */
export type SourceKind = "GOVERNMENT" | "SELF_DECLARED" | "DERIVED";

export interface GovernmentField {
  /** Field key as returned by the API, e.g. "legalCompanyName". */
  name: string;
  /**
   * Display value, already flattened to a string. `null` means the source
   * returned nothing for this field — normal and NOT adverse (ZM-GOV-003).
   */
  value: string | null;
  source: GovernmentSource | null;
  retrievedAt: string | null;
  sourceKind: SourceKind | null;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(asString).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  return null;
}

function asSourceKind(value: unknown): SourceKind | null {
  return value === "GOVERNMENT" || value === "SELF_DECLARED" || value === "DERIVED" ? value : null;
}

/** True for `{ value, sourceKind, source, retrievedAt }`-shaped entries (the Q-05 answer). */
function isProvenanceEntry(entry: unknown): entry is Record<string, unknown> {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    ("value" in entry || "source" in entry || "sourceKind" in entry)
  );
}

export function normalizeGovernmentField(name: string, entry: unknown): GovernmentField {
  if (!isProvenanceEntry(entry)) {
    // Bare value — renders read-only without a badge rather than guessing a source.
    return {
      name,
      value: asString(entry),
      source: null,
      retrievedAt: null,
      sourceKind: null,
    };
  }
  return {
    name,
    value: asString(entry.value),
    source: isGovernmentSource(entry.source) ? entry.source : null,
    retrievedAt: asString(entry.retrievedAt),
    sourceKind: asSourceKind(entry.sourceKind),
  };
}

export function normalizeGovernmentData(
  data: Record<string, unknown> | undefined
): GovernmentField[] {
  if (!data) return [];
  return Object.entries(data).map(([name, entry]) => normalizeGovernmentField(name, entry));
}

/**
 * Display order for the CCD/ISTD/GAM fields listed in requirements §5.3.
 * Fields not in this list keep their API order, appended after the known ones —
 * a new field from A shows up rather than silently disappearing.
 */
const FIELD_ORDER = [
  "legalCompanyName",
  "companyNumber",
  "companyType",
  "registryStatus",
  "registrationDate",
  "lastModificationDate",
  "registeredAddress",
  "governorate",
  "registeredContacts",
  "capital",
  "authorizedSignatories",
  "businessPurposes",
  "partners",
  "management",
  "announcements",
  "taxNumber",
  "taxRegistrationStatus",
  "taxRegisteredName",
  "licenceNumber",
  "licenceStatus",
  "licenceActivity",
  "licenceAddress",
  "licenceIssueDate",
  "licenceExpiryDate",
];

export function sortGovernmentFields(fields: GovernmentField[]): GovernmentField[] {
  const rank = (name: string) => {
    const i = FIELD_ORDER.indexOf(name);
    return i === -1 ? FIELD_ORDER.length : i;
  };
  return [...fields].sort((a, b) => rank(a.name) - rank(b.name));
}

/** Group by the source that produced them, so each panel can carry one badge. */
export function groupBySource(fields: GovernmentField[]): Map<GovernmentSource | null, GovernmentField[]> {
  const groups = new Map<GovernmentSource | null, GovernmentField[]>();
  for (const field of fields) {
    const existing = groups.get(field.source);
    if (existing) existing.push(field);
    else groups.set(field.source, [field]);
  }
  return groups;
}

/**
 * ZM-SON-013: sole proprietorships cannot be verified through CCD in V3.
 * Detected from the registry's own company-type value, never guessed from a name.
 */
const SOLE_PROPRIETORSHIP_TYPES = ["SOLE_PROPRIETORSHIP", "SOLE PROPRIETORSHIP", "مؤسسة فردية"];

export function isSoleProprietorship(fields: GovernmentField[]): boolean {
  const companyType = fields.find((f) => f.name === "companyType")?.value;
  return !!companyType && SOLE_PROPRIETORSHIP_TYPES.includes(companyType.toUpperCase());
}
