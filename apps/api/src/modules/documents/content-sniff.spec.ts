import { contentMatchesDeclared, sniffContentType } from './content-sniff';

/** Minimal byte fixtures carrying just the signature each type is known by. */
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const TIFF_LE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
const TIFF_BE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00]);
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
const TEXT = Buffer.from('just some words', 'utf8');

describe('sniffContentType', () => {
  it('recognizes each accepted upload type by its magic number', () => {
    expect(sniffContentType(PDF)).toBe('application/pdf');
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    expect(sniffContentType(TIFF_LE)).toBe('image/tiff');
    expect(sniffContentType(TIFF_BE)).toBe('image/tiff');
  });

  it('returns null for content it does not recognize', () => {
    expect(sniffContentType(HTML)).toBeNull();
    expect(sniffContentType(TEXT)).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });
});

describe('contentMatchesDeclared', () => {
  it('accepts bytes that match the declared type', () => {
    expect(contentMatchesDeclared('application/pdf', PDF)).toBe(true);
    expect(contentMatchesDeclared('image/png', PNG)).toBe(true);
    expect(contentMatchesDeclared('image/jpeg', JPEG)).toBe(true);
    expect(contentMatchesDeclared('image/tiff', TIFF_BE)).toBe(true);
  });

  it('treats image/jpg as an alias of image/jpeg', () => {
    expect(contentMatchesDeclared('image/jpg', JPEG)).toBe(true);
  });

  it('rejects a file disguised under the wrong declared type', () => {
    // The attack this exists for: an HTML/script payload claiming to be a PDF.
    expect(contentMatchesDeclared('application/pdf', HTML)).toBe(false);
    // A real PNG mislabelled as a PDF is still refused — the label is a claim,
    // the bytes are the fact.
    expect(contentMatchesDeclared('application/pdf', PNG)).toBe(false);
    expect(contentMatchesDeclared('image/png', JPEG)).toBe(false);
  });

  it('rejects unrecognized content regardless of the declared type', () => {
    expect(contentMatchesDeclared('application/pdf', TEXT)).toBe(false);
  });
});
