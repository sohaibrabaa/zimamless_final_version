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
 * Which one applies is decided by whether SUPABASE_JWT_SECRET is set, so a
 * project migrating from one to the other is a config change rather than a
 * code change. Getting this wrong presents as "every request is 401", which
 * is why the failure messages below distinguish the causes.
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
    if (this.config.supabase.jwtSecret) {
      this.hmacKey = new TextEncoder().encode(this.config.supabase.jwtSecret);
      this.logger.log('JWT verification: HS256 using the project JWT secret.');
    } else {
      const url = new URL('/auth/v1/.well-known/jwks.json', this.config.supabase.url);
      // Keys are fetched on demand and cached by jose, with rotation handled
      // for us. Doing this at boot would make startup depend on Supabase
      // being reachable, which is a worse failure mode.
      this.jwks = createRemoteJWKSet(url, { cooldownDuration: 30_000 });
      this.logger.log(`JWT verification: asymmetric via JWKS at ${url.href}`);
    }
  }

  async verify(token: string): Promise<VerifiedToken> {
    let payload: JWTPayload;
    try {
      const result = this.hmacKey
        ? await jwtVerify(token, this.hmacKey, { algorithms: ['HS256'] })
        : await jwtVerify(token, this.jwks!, { algorithms: ['ES256', 'RS256'] });
      payload = result.payload;
    } catch (err) {
      const reason = (err as Error).message;
      // Logged, not returned: the client learns only that the token failed.
      // Telling an attacker "signature invalid" vs "expired" is free
      // information about how far they got.
      this.logger.debug(`Token verification failed: ${reason}`);
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
