import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { VerifiedToken } from './jwt-verifier.service';
import { HttpStatus } from '@nestjs/common';

export interface PlatformUser {
  id: string;
  auth_user_id: string;
  full_name: string;
  email: string;
  phone_number: string;
  preferred_language: 'EN' | 'AR';
  mfa_enabled: boolean;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
}

export interface MembershipRow {
  organization_id: string;
  organization_name: string;
  organization_type: 'SUPPLIER' | 'BANK' | 'PLATFORM';
  organization_status: string;
  roles: string[];
  is_authorized_signatory: boolean;
  membership_status: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Resolve the platform `users` row for a verified token, creating it on
   * first sight.
   *
   * PA-04: signup happens client-side against Supabase Auth, so the first
   * this API hears of a user is a valid token for someone with no row. The
   * row is created lazily here rather than by a webhook — one less moving
   * part between Supabase and us, and no window where a user can hold a
   * valid token the API refuses to recognise.
   *
   * The INSERT is idempotent under concurrency: two simultaneous first
   * requests race on the auth_user_id unique index and the loser re-reads.
   */
  async syncUser(token: VerifiedToken): Promise<PlatformUser> {
    const existing = await this.db.queryOne<PlatformUser>(
      `SELECT id, auth_user_id, full_name, email, phone_number,
              preferred_language, mfa_enabled, status
         FROM users WHERE auth_user_id = $1`,
      [token.authUserId],
    );
    if (existing) return this.assertUsable(existing);

    // The seed and the onboarding bootstrap may have created the row by
    // email before the user ever signed in (bank and platform staff are
    // seed-only per PA-01/PA-02). Claim it rather than creating a duplicate,
    // which users.email UNIQUE would reject anyway.
    if (token.email) {
      const byEmail = await this.db.queryOne<PlatformUser>(
        `UPDATE users
            SET auth_user_id = $1, updated_at = now()
          WHERE email = $2 AND auth_user_id IS NULL
      RETURNING id, auth_user_id, full_name, email, phone_number,
                preferred_language, mfa_enabled, status`,
        [token.authUserId, token.email],
      );
      if (byEmail) return this.assertUsable(byEmail);
    }

    if (!token.email) {
      // Every users row needs an email (NOT NULL UNIQUE) and we will not
      // invent one; a Supabase user without an email cannot be onboarded.
      throw AppException.invalidToken('This account has no email address associated with it.');
    }

    const created = await this.db.queryOne<PlatformUser>(
      `INSERT INTO users (auth_user_id, full_name, email, phone_number, preferred_language)
       VALUES ($1, $2, $3, $4, 'EN')
       ON CONFLICT (auth_user_id) DO UPDATE SET updated_at = now()
       RETURNING id, auth_user_id, full_name, email, phone_number,
                 preferred_language, mfa_enabled, status`,
      [
        token.authUserId,
        // Real names arrive during onboarding; the local part is a
        // placeholder so the NOT NULL holds without inventing a person.
        token.email.split('@')[0],
        token.email,
        token.phone ?? '',
      ],
    );

    if (!created) {
      // ON CONFLICT (auth_user_id) did not fire but the insert returned
      // nothing: the email unique index caught a row we could not claim
      // above, i.e. that email belongs to a different auth user.
      throw new AppException(
        ErrorCode.CONFLICT,
        'This email address is already registered to another account.',
        HttpStatus.CONFLICT,
      );
    }

    // ZM-I18N-003: English default, never inferred from the request locale.
    return this.assertUsable(created);
  }

  private assertUsable(user: PlatformUser): PlatformUser {
    if (user.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCode.USER_SUSPENDED,
        'This account is not active. Contact platform support.',
        HttpStatus.FORBIDDEN,
      );
    }
    return user;
  }

  /**
   * Every ACTIVE membership for a user, with roles aggregated.
   *
   * Multi-org is a first-class case, not an edge case: a person may act for
   * more than one organization, which is exactly why the active context is
   * an explicit header rather than something inferred from the user.
   */
  async listMemberships(userId: string): Promise<MembershipRow[]> {
    const { rows } = await this.db.query<MembershipRow>(
      `SELECT m.organization_id,
              o.legal_name        AS organization_name,
              o.organization_type,
              o.status::text      AS organization_status,
              m.is_authorized_signatory,
              m.status::text      AS membership_status,
              coalesce(
                array_agg(r.role::text ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL),
                '{}'
              ) AS roles
         FROM organization_memberships m
         JOIN organizations o ON o.id = m.organization_id
    LEFT JOIN membership_roles r ON r.membership_id = m.id
        WHERE m.user_id = $1
          AND m.status = 'ACTIVE'
          AND (m.valid_to IS NULL OR m.valid_to > now())
     GROUP BY m.organization_id, o.legal_name, o.organization_type, o.status,
              m.is_authorized_signatory, m.status
     ORDER BY o.legal_name`,
      [userId],
    );
    return rows;
  }

  /**
   * The membership backing a requested organization context.
   *
   * Cross-cutting rule 1: a header naming an org the user does not belong to
   * is 403. Resolved by re-reading memberships rather than trusting anything
   * in the token, because org membership can be revoked mid-session and the
   * token would not know.
   */
  async resolveContext(userId: string, organizationId: string): Promise<MembershipRow> {
    const memberships = await this.listMemberships(userId);
    const match = memberships.find((m) => m.organization_id === organizationId);
    if (!match) throw AppException.organizationContextInvalid();
    return match;
  }

  async setPreferredLanguage(userId: string, language: 'EN' | 'AR'): Promise<void> {
    await this.db.query(`UPDATE users SET preferred_language = $1, updated_at = now() WHERE id = $2`, [
      language,
      userId,
    ]);
  }
}
