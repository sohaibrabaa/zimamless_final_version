import { Injectable } from '@nestjs/common';

/**
 * The signature provider seam (ZM-CON-007..009, 011).
 *
 * ZM-CON-009 requires that a production PKI or qualified-signature provider
 * be insertable later **without core domain changes**. That constrains this
 * interface more than it might look:
 *
 *   - It takes and returns plain data, no database handles and no Nest
 *     injectables, so an adapter for a hosted provider is a network call and
 *     nothing else.
 *   - `sign` and `verify` are **separate operations**, because ZM-CON-011
 *     says a signature counts only after verification confirms document
 *     integrity, signer identity and signer authority. Folding verification
 *     into signing would make that requirement structurally unexpressible —
 *     and with a real provider the two genuinely are separate moments, often
 *     separated by a callback.
 *   - Nothing here knows what a contract is. It signs a *document hash*.
 *
 * The dummy provider below is the competition's implementation: in-platform
 * click-to-accept (ZM-CON-008). It is honest about being a dummy — it does
 * not pretend to cryptography it does not perform, and `verify` checks the
 * things it can actually check rather than returning a decorative `true`.
 */

export interface SignatureRequest {
  /** Hash of the exact bytes presented to the signer. */
  readonly documentHash: string;
  readonly signerUserId: string;
  readonly signerOrgId: string;
  readonly signerName: string;
  readonly signerCapacity: 'SUPPLIER_AUTHORIZED_SIGNATORY' | 'BANK_AUTHORIZED_SIGNATORY';
  /** Whether the platform has confirmed this user may sign for the org. */
  readonly signerIsAuthorized: boolean;
  readonly signedAt: Date;
  readonly ipAddress: string | null;
  readonly deviceInfo: string | null;
}

export interface SignatureResult {
  readonly providerName: string;
  /** What the provider considers the signed artifact's hash. */
  readonly signedDocumentHash: string;
  readonly evidence: Record<string, unknown>;
}

export interface VerificationInput {
  readonly signature: SignatureResult;
  readonly request: SignatureRequest;
  /** The hash of the document as it stands NOW, re-read at verification. */
  readonly currentDocumentHash: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: {
    readonly documentIntegrity: boolean;
    readonly signerIdentity: boolean;
    readonly signerAuthority: boolean;
  };
  readonly failureReason: string | null;
}

export interface SignatureProvider {
  readonly name: string;
  sign(request: SignatureRequest): Promise<SignatureResult>;
  verify(input: VerificationInput): Promise<VerificationResult>;
}

export const SIGNATURE_PROVIDER = Symbol('SIGNATURE_PROVIDER');

/**
 * In-platform click-to-accept (ZM-CON-008).
 *
 * Records everything the requirement enumerates: signer identity,
 * organization, capacity, timestamp, IP, device metadata and the signed
 * document hash. The audit trail is written by the service around it, not
 * here, because an audit row belongs in the same database transaction as the
 * change it describes and a provider adapter has no business holding one.
 *
 * What this deliberately does NOT do is generate anything that resembles a
 * cryptographic signature. There is no key, so there is no signature — only a
 * recorded act of assent bound to a document hash. Producing a plausible-
 * looking token here would be worse than useless: it would invite someone to
 * treat it as evidence of something it never was.
 */
@Injectable()
export class DummySignatureProvider implements SignatureProvider {
  readonly name = 'DUMMY';

  async sign(request: SignatureRequest): Promise<SignatureResult> {
    return {
      providerName: this.name,
      // The signed artifact IS the document — click-to-accept adds no
      // envelope — so the signed hash equals the presented hash. Stated
      // explicitly rather than left implicit, because a real provider's
      // signed hash usually differs and the field must not be assumed equal.
      signedDocumentHash: request.documentHash,
      evidence: {
        method: 'IN_PLATFORM_CLICK_TO_ACCEPT',
        signerUserId: request.signerUserId,
        signerOrgId: request.signerOrgId,
        signerName: request.signerName,
        signerCapacity: request.signerCapacity,
        signedAt: request.signedAt.toISOString(),
        ipAddress: request.ipAddress,
        deviceInfo: request.deviceInfo,
        presentedDocumentHash: request.documentHash,
        // Named plainly so that nobody reading a stored evidence blob two
        // years from now mistakes it for a qualified electronic signature.
        disclaimer:
          'Demonstration provider. This records an in-platform act of assent bound to a ' +
          'document hash. It is not a cryptographic or qualified electronic signature.',
      },
    };
  }

  async verify(input: VerificationInput): Promise<VerificationResult> {
    // The three checks ZM-CON-011 names, each answered by something this
    // provider can genuinely establish.
    const documentIntegrity =
      input.signature.signedDocumentHash === input.currentDocumentHash &&
      input.request.documentHash === input.currentDocumentHash;

    const documentedSigner = input.signature.evidence.signerUserId;
    const signerIdentity = documentedSigner === input.request.signerUserId;

    const signerAuthority = input.request.signerIsAuthorized === true;

    const failures: string[] = [];
    if (!documentIntegrity) {
      failures.push('the document has changed since it was signed');
    }
    if (!signerIdentity) failures.push('the recorded signer does not match the signature');
    if (!signerAuthority) failures.push('the signer is not an authorized signatory');

    return {
      verified: failures.length === 0,
      checks: { documentIntegrity, signerIdentity, signerAuthority },
      failureReason: failures.length === 0 ? null : failures.join('; '),
    };
  }
}
