import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload, createLocalJWKSet } from 'jose';
import { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/errors/app.exception';

/**
 * Verifies Supabase Auth access tokens.
 *
 * Supabase projects sign either way and both are in the field:
 *   - legacy projects use HS256 with the project's shared JWT secret;
 *   - current projects use asymmetric keys (ES256/RS256) published at
 *     /auth/v1/.well-known/jwks.json.
 *
 * The choice is made PER TOKEN, from its own `alg` header — not from whether
 * SUPABASE_JWT_SECRET happens to be configured. A project part-way through
 * Supabase's migration to asymmetric keys still displays a legacy JWT secret
 * in its dashboard while already issuing ES256 tokens, so keying off config
 * presence rejects every valid token with a 401 that blames the token. Both
 * verifiers are therefore prepared at boot and selected at verify time.
 *
 * PA-04: registration, email, and phone verification happen client-side
 * against Supabase directly. This API never issues a token — it only
 * verifies. A token that verifies means Supabase already checked the
 * password and any MFA.
 */
export interface VerifiedToken {
  /** auth.users.id — joins to users.auth_user_id. */
  authUserId: string;
  email?: string;
  phone?: string;
  expiresAt?: number;
}

@Injectable()
export class JwtVerifierService implements OnModuleInit {
  private readonly logger = new Logger(JwtVerifierService.name);
  private jwks?: ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;
  private hmacKey?: Uint8Array;

  constructor(private readonly config: AppConfig) {}

  onModuleInit(): void {
    // Both paths are prepared unconditionally; the token decides which runs.
    if (this.config.supabase.jwtSecret) {
      this.hmacKey = new TextEncoder().encode(this.config.supabase.jwtSecret);
    }

    const url = new URL('/auth/v1/.well-known/jwks.json', this.config.supabase.url);
    // Keys are fetched on demand and cached by jose, with rotation handled
    // for us. Doing this at boot would make startup depend on Supabase being
    // reachable, which is a worse failure mode.
    this.jwks = createRemoteJWKSet(url, { cooldownDuration: 30_000 });

    this.logger.log(
      `JWT verification ready: asymmetric via JWKS (${url.href})` +
        (this.hmacKey ? ', plus HS256 for legacy tokens.' : '.'),
    );
  }

  async verify(token: string): Promise<VerifiedToken> {
    // Read the algorithm from the token's own header. `alg` is unauthenticated
    // input, so it selects a verifier but never relaxes one: an HS256 token is
    // checked against the shared secret and nothing else, and an ES256 token
    // against the JWKS and nothing else. Passing both key types to a single
    // jwtVerify call is what enables algorithm-confusion attacks; this does
    // not do that.
    const algorithm = readAlgorithm(token);

    let payload: JWTPayload;
    try {
      if (algorithm === 'HS256') {
        if (!this.hmacKey) {
          this.logger.warn(
            'Received an HS256 token but SUPABASE_JWT_SECRET is not configured.',
          );
          throw AppException.invalidToken();
        }
        payload = (await jwtVerify(token, this.hmacKey, { algorithms: ['HS256'] })).payload;
      } else {
        payload = (await jwtVerify(token, this.jwks!, { algorithms: ['ES256', 'RS256'] })).payload;
      }
    } catch (err) {
      if (err instanceof AppException) throw err;
      const reason = (err as Error).message;
      // Logged, not returned: the client learns only that the token failed.
      // Telling an attacker "signature invalid" vs "expired" is free
      // information about how far they got.
      this.logger.debug(`Token verification failed (alg=${algorithm}): ${reason}`);
      throw AppException.invalidToken();
    }

    // Supabase issues `authenticated` for signed-in users. Anon-key tokens
    // carry role `anon` and must not be treated as a session: they identify
    // the project, not a person.
    if (payload.role !== undefined && payload.role !== 'authenticated') {
      throw AppException.invalidToken('This token does not represent a signed-in user.');
    }

    const sub = payload.sub;
    if (!sub || typeof sub !== 'string') {
      throw AppException.invalidToken('The token has no subject claim.');
    }

    return {
      authUserId: sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      phone: typeof payload.phone === 'string' ? payload.phone : undefined,
      expiresAt: payload.exp,
    };
  }
}

/**
 * Reads `alg` from the JOSE header without verifying anything.
 *
 * Safe because the value only routes to a verifier — every algorithm is then
 * pinned explicitly at the jwtVerify call, so a forged header cannot cause a
 * token to be accepted under weaker terms. Anything unrecognised falls
 * through to the asymmetric path, which will reject it.
 */
function readAlgorithm(token: string): string {
  try {
    const [header] = token.split('.');
    const json = Buffer.from(header, 'base64url').toString('utf8');
    const alg = (JSON.parse(json) as { alg?: unknown }).alg;
    return typeof alg === 'string' ? alg : 'unknown';
  } catch {
    return 'unknown';
  }
}
