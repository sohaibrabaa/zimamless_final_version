import { DummySignatureProvider, type SignatureRequest } from './signature.provider';

const provider = new DummySignatureProvider();

const request = (overrides: Partial<SignatureRequest> = {}): SignatureRequest => ({
  documentHash: 'sha256:aaa',
  signerUserId: 'user-1',
  signerOrgId: 'org-1',
  signerName: 'Layla Haddad',
  signerCapacity: 'SUPPLIER_AUTHORIZED_SIGNATORY',
  signerIsAuthorized: true,
  signedAt: new Date('2026-07-23T10:00:00Z'),
  ipAddress: '203.0.113.7',
  deviceInfo: 'Mozilla/5.0',
  ...overrides,
});

describe('ZM-CON-008 — what click-to-accept records', () => {
  it('records every field the requirement enumerates', () => {
    return provider.sign(request()).then((result) => {
      const evidence = result.evidence;
      expect(evidence.signerUserId).toBe('user-1');
      expect(evidence.signerOrgId).toBe('org-1');
      expect(evidence.signerName).toBe('Layla Haddad');
      expect(evidence.signerCapacity).toBe('SUPPLIER_AUTHORIZED_SIGNATORY');
      expect(evidence.signedAt).toBe('2026-07-23T10:00:00.000Z');
      expect(evidence.ipAddress).toBe('203.0.113.7');
      expect(evidence.deviceInfo).toBe('Mozilla/5.0');
      expect(evidence.presentedDocumentHash).toBe('sha256:aaa');
    });
  });

  it('says in the evidence itself that it is not a qualified signature', () => {
    // Nobody reading a stored evidence blob two years from now should be
    // able to mistake this for cryptography it never performed.
    return provider.sign(request()).then((result) => {
      expect(String(result.evidence.disclaimer)).toMatch(/not a cryptographic or qualified/i);
    });
  });

  it('binds the signature to the presented document hash', () => {
    return provider.sign(request({ documentHash: 'sha256:bbb' })).then((result) => {
      expect(result.signedDocumentHash).toBe('sha256:bbb');
    });
  });
});

describe('ZM-CON-011 — verification checks all three things', () => {
  it('verifies a clean signature', async () => {
    const req = request();
    const signature = await provider.sign(req);
    const result = await provider.verify({
      signature,
      request: req,
      currentDocumentHash: req.documentHash,
    });
    expect(result.verified).toBe(true);
    expect(result.checks).toEqual({
      documentIntegrity: true,
      signerIdentity: true,
      signerAuthority: true,
    });
    expect(result.failureReason).toBeNull();
  });

  it('fails when the document changed after signing', async () => {
    // The whole value of a signature is that it binds a person to specific
    // bytes. Different bytes, no signature.
    const req = request();
    const signature = await provider.sign(req);
    const result = await provider.verify({
      signature,
      request: req,
      currentDocumentHash: 'sha256:something-else',
    });
    expect(result.verified).toBe(false);
    expect(result.checks.documentIntegrity).toBe(false);
    expect(result.failureReason).toContain('the document has changed');
  });

  it('fails when the recorded signer does not match the signature', async () => {
    const signature = await provider.sign(request({ signerUserId: 'user-1' }));
    const result = await provider.verify({
      signature,
      request: request({ signerUserId: 'user-2' }),
      currentDocumentHash: 'sha256:aaa',
    });
    expect(result.verified).toBe(false);
    expect(result.checks.signerIdentity).toBe(false);
  });

  it('fails when the signer is not an authorized signatory', async () => {
    const req = request({ signerIsAuthorized: false });
    const signature = await provider.sign(req);
    const result = await provider.verify({
      signature,
      request: req,
      currentDocumentHash: req.documentHash,
    });
    expect(result.verified).toBe(false);
    expect(result.checks.signerAuthority).toBe(false);
    expect(result.failureReason).toContain('not an authorized signatory');
  });

  it('reports every failed check, not the first', async () => {
    const req = request({ signerIsAuthorized: false });
    const signature = await provider.sign(req);
    const result = await provider.verify({
      signature,
      request: req,
      currentDocumentHash: 'sha256:changed',
    });
    expect(result.failureReason).toContain('the document has changed');
    expect(result.failureReason).toContain('not an authorized signatory');
  });
});

describe('ZM-CON-009 — the seam is swappable', () => {
  it('takes and returns plain data, with no framework or database in the signature', () => {
    // If this test ever needs a Nest testing module to construct the
    // provider, the seam has stopped being a seam.
    expect(typeof provider.sign).toBe('function');
    expect(typeof provider.verify).toBe('function');
    expect(provider.name).toBe('DUMMY');
  });

  it('signing and verifying are separate operations', async () => {
    // With a real provider verification is asynchronous, often a callback.
    // Folding it into sign() would make ZM-CON-011 structurally
    // unexpressible.
    const req = request();
    const signature = await provider.sign(req);
    expect(signature).not.toHaveProperty('verified');
  });
});
