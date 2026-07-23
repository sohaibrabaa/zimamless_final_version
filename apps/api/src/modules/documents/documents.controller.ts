import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { UploadUrlDto } from './dto';
import { Audit } from '../../common/audit/audit.interceptor';
import { CurrentContext, CurrentUser } from '../auth/decorators';
import { MembershipRow, PlatformUser } from '../auth/auth.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { AppException } from '../../common/errors/app.exception';

/**
 * Documents (contract /documents/*).
 *
 * Every route here reveals something about a stored file — a URL, an
 * extraction, a hash — and every one of them goes through
 * `DocumentsService.requireReadable()` first. ZM-DOC-004's "issued only
 * after a server-side authorization check" is a statement about ordering,
 * and the ordering lives in the service rather than here so a new route
 * cannot forget it.
 */
@ApiTags('Documents')
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  private contextOf(user: PlatformUser, membership: MembershipRow | undefined): ActorContext {
    if (!membership) throw AppException.organizationContextRequired();
    return {
      userId: user.id,
      organizationId: membership.organization_id,
      organizationType: membership.organization_type,
      roles: membership.roles,
    };
  }

  @Post('documents/upload-url')
  // The contract declares 200 for this route, not POST's default 201.
  @HttpCode(HttpStatus.OK)
  @Audit('DOCUMENT_UPLOAD_URL_ISSUED', 'DOCUMENT')
  @ApiOperation({ summary: 'Reserve a document and get a short-lived signed upload URL' })
  @ApiResponse({ status: 200, description: 'Document id and signed upload URL' })
  async uploadUrl(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Body() body: UploadUrlDto,
  ): Promise<Record<string, unknown>> {
    return this.documents.createUploadUrl(this.contextOf(user, membership), body);
  }

  @Get('documents/:id/download-url')
  @ApiOperation({
    summary: 'Short-lived signed download URL',
    description: 'Authorization is checked server-side before any URL is issued (ZM-DOC-004).',
  })
  @ApiResponse({ status: 200, description: 'Signed URL and its expiry' })
  @ApiResponse({ status: 404, description: 'No such document, or not visible to the caller' })
  async downloadUrl(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.documents.createDownloadUrl(id, this.contextOf(user, membership));
  }

  @Get('documents/:id/extraction')
  @ApiOperation({
    summary: 'OCR and QR extraction result',
    description:
      'Machine output is preserved separately from supplier corrections; both are returned (ZM-DOC-006).',
  })
  @ApiResponse({ status: 200, description: 'Extraction' })
  async extraction(
    @CurrentUser() user: PlatformUser,
    @CurrentContext() membership: MembershipRow,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.documents.getExtraction(id, this.contextOf(user, membership));
  }
}
