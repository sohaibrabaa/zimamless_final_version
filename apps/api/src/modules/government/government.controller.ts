import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GovernmentService, SubjectType } from './government.service';
import { GovSource } from './government-adapter';
import { GovernmentLookupDto } from '../onboarding/dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { AppException } from '../../common/errors/app.exception';

/**
 * Government verification (contract /government/*).
 *
 * `sourceAvailable` is on every response and is the field consumers must
 * branch on. A client that renders "not found" for an unavailable source
 * has reintroduced the exact confusion hard rule 7 forbids — so the field
 * is always present, never optional, and never inferred from `status`
 * alone by the caller.
 */
@ApiTags('Government')
@Controller()
export class GovernmentController {
  constructor(private readonly government: GovernmentService) {}

  @Post('government/lookup')
  // The contract declares 202 Accepted: a real registry call is
  // asynchronous. The dummy adapters answer inline, but the status code is
  // the contract's and the response is the request resource either way, so
  // the client polls identically against a live integration later.
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('GOVERNMENT_LOOKUP_REQUESTED', 'GOVERNMENT_VERIFICATION_REQUEST')
  @ApiOperation({ summary: 'Trigger a registry lookup via adapter' })
  @ApiResponse({ status: 202, description: 'Accepted — poll the request for result' })
  async lookup(@Body() body: GovernmentLookupDto): Promise<Record<string, unknown>> {
    const { request } = await this.government.lookup({
      source: body.source as GovSource,
      lookupKey: body.lookupKey,
      subjectType: (body.subjectType ?? 'ORGANIZATION') as SubjectType,
      subjectId: body.subjectId ?? null,
    });
    return this.present(request);
  }

  @Get('government/requests/:id')
  @ApiOperation({ summary: 'Poll a government verification request' })
  @ApiResponse({ status: 200, description: 'Government request' })
  async request(@Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const request = await this.government.getRequest(id);
    if (!request) throw AppException.notFound('Government request');
    return this.present(request);
  }

  private async present(request: {
    id: string;
    source: string;
    status: string;
    source_available: boolean;
    responded_at: Date | null;
  }): Promise<Record<string, unknown>> {
    const snapshot = await this.government.snapshotOf(request.id);
    return {
      id: request.id,
      source: request.source,
      status: request.status,
      // Never derived by the caller. See the class comment.
      sourceAvailable: request.source_available,
      normalizedData: snapshot?.normalized_payload ?? null,
      retrievedAt: snapshot?.retrieved_at?.toISOString() ?? request.responded_at?.toISOString() ?? null,
      validUntil: snapshot?.valid_until?.toISOString() ?? null,
    };
  }
}
