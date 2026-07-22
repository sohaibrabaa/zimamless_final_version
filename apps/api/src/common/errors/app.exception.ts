import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodeValue, ErrorCode } from './error-codes';

/**
 * The only exception type domain code should throw.
 *
 * Carrying the stable `code` alongside the HTTP status keeps the two from
 * drifting, and gives the exception filter everything it needs to emit the
 * contract's Error envelope without guessing.
 *
 * `details` is returned to the caller. Nothing confidential goes in it —
 * in particular never `minimumAcceptableAmount`, which INV-8 forbids from
 * every bank-facing payload *including validation errors* (contract rule 2).
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }

  static unauthenticated(message = 'Authentication required.'): AppException {
    return new AppException(ErrorCode.UNAUTHENTICATED, message, HttpStatus.UNAUTHORIZED);
  }

  static invalidToken(message = 'The access token is invalid or has expired.'): AppException {
    return new AppException(ErrorCode.INVALID_TOKEN, message, HttpStatus.UNAUTHORIZED);
  }

  /**
   * Cross-cutting rule 1 is explicit that a missing or non-member
   * X-Organization-Id is 403 — not 400 and not 401.
   */
  static organizationContextRequired(): AppException {
    return new AppException(
      ErrorCode.ORGANIZATION_CONTEXT_REQUIRED,
      'The X-Organization-Id header is required and must name an organization you belong to.',
      HttpStatus.FORBIDDEN,
    );
  }

  static organizationContextInvalid(): AppException {
    // The message does not distinguish "no such org" from "you are not a
    // member": either answer would confirm the existence of an organization
    // to someone probing for it.
    return new AppException(
      ErrorCode.ORGANIZATION_CONTEXT_INVALID,
      'You do not have an active membership in the requested organization.',
      HttpStatus.FORBIDDEN,
    );
  }

  static insufficientRole(required: string[]): AppException {
    return new AppException(
      ErrorCode.INSUFFICIENT_ROLE,
      'Your role in this organization does not permit this action.',
      HttpStatus.FORBIDDEN,
      { requiredRoles: required },
    );
  }

  static notFound(entity: string): AppException {
    return new AppException(ErrorCode.NOT_FOUND, `${entity} was not found.`, HttpStatus.NOT_FOUND);
  }

  static conflict(code: ErrorCodeValue, message: string, details?: Record<string, unknown>): AppException {
    return new AppException(code, message, HttpStatus.CONFLICT, details);
  }

  static validation(message: string, details?: Record<string, unknown>): AppException {
    return new AppException(
      ErrorCode.VALIDATION_FAILED,
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
      details,
    );
  }
}
