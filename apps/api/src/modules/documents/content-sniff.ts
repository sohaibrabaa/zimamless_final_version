/**
 * Content sniffing for uploaded documents.
 *
 * The upload goes straight from the browser to Supabase Storage, so at
 * *reservation* time the API has only the client's declared `mimeType` to go
 * on, and a declaration is not evidence — a caller can claim `application/pdf`
 * and PUT an HTML file, or an executable, to the same signed URL. The bucket's
 * own allow-list matches the Content-Type the client sends, which is the same
 * unverified claim.
 *
 * The API does see the bytes exactly once: at finalization, when it downloads
 * the object to hash it (`DocumentsService.ensureFinalized`). That is the only
 * place the declared type can be checked against what was actually stored, so
 * that is where this runs. A file whose leading bytes do not match its
 * declared type is refused before it is hashed, extracted, or attached to a
 * transaction.
 *
 * This is a magic-number check, not a full parse: it reads the first handful
 * of bytes and asks "could this be a PDF/PNG/JPEG/TIFF?". Every type this
 * product accepts has a stable, well-known signature, which is enough to catch
 * a mislabelled — or disguised — upload. It deliberately does not try to
 * validate the whole file; that is the extraction pipeline's job.
 */

/** The magic-number signatures for the four accepted upload types. */
const SIGNATURES: { mime: string; match: (b: Buffer) => boolean }[] = [
  // %PDF-
  { mime: 'application/pdf', match: (b) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
  // \x89 P N G \r \n \x1a \n
  {
    mime: 'image/png',
    match: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  // FF D8 FF — the SOI marker every JPEG opens with.
  { mime: 'image/jpeg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // TIFF is little-endian "II*\0" or big-endian "MM\0*".
  {
    mime: 'image/tiff',
    match: (b) =>
      b.length >= 4 &&
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)),
  },
];

/**
 * The type suggested by the file's leading bytes, or null if it matches none
 * of the signatures we recognize.
 */
export function sniffContentType(bytes: Buffer): string | null {
  for (const sig of SIGNATURES) {
    if (sig.match(bytes)) return sig.mime;
  }
  return null;
}

/**
 * Whether the stored bytes are consistent with the type the client declared.
 *
 * The declared type is always one of `ALLOWED_MIME_TYPES` by the time an
 * upload is reserved (the DTO enforces that), and every one of those four has
 * a signature here — so a declared type that the bytes do not match is a
 * genuine mismatch, not merely an unrecognized format. `image/jpeg` and its
 * historical alias `image/jpg` are treated as the same thing.
 */
export function contentMatchesDeclared(declaredMime: string, bytes: Buffer): boolean {
  const detected = sniffContentType(bytes);
  if (detected === null) return false;
  const declared = declaredMime === 'image/jpg' ? 'image/jpeg' : declaredMime;
  return detected === declared;
}
