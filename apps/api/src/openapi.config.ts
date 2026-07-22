import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, OpenAPIObject } from '@nestjs/swagger';

/**
 * The OpenAPI document definition, shared by the running server (main.ts,
 * served at /docs-json) and the CI emitter (openapi.ts).
 *
 * Shared deliberately: if the gate built its document differently from the
 * one served, the gate would be checking something no client ever sees.
 */
export function buildOpenApiDocument(app: INestApplication, port = 3000): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Zimmamless V3 API')
    .setDescription('Receivables marketplace connecting Jordanian suppliers with banks.')
    // 3.1.0 = frozen 3.0.0 + the approved v3.1.0 additive overlay.
    .setVersion('3.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearerAuth')
    .addGlobalParameters({
      name: 'X-Organization-Id',
      in: 'header',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description: 'Active organization context. Missing or non-member → 403.',
    })
    .addServer(`http://localhost:${port}/v1`, 'Local')
    .addServer('https://api.zimmamless.com/v1', 'Production')
    .build();

  return SwaggerModule.createDocument(app, config);
}
