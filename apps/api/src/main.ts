import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { AppLogger } from './common/logging/app-logger.service';
import { SystemTimeProvider } from './common/time/time.provider';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(AppConfig);
  const logger = app.get(AppLogger);
  logger.setLevel(config.logLevel);
  app.useLogger(logger);

  // The contract's servers block is http://localhost:3000/v1, so every
  // documented path lives under /v1. /health is the one exception and is
  // registered outside the prefix, where probes expect it.
  app.setGlobalPrefix(config.globalPrefix, { exclude: ['health'] });

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    // X-Organization-Id is required on every request (cross-cutting rule 1),
    // so the browser must be allowed to send it; X-Correlation-Id is exposed
    // so Agent B can surface it in error reports.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Organization-Id',
      'Idempotency-Key',
      'Accept-Language',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['X-Correlation-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip and reject unknown properties: a client sending an extra field
      // is either out of date or probing, and silently accepting it hides
      // contract drift that the conformance gate is meant to catch.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // --- OpenAPI ---------------------------------------------------------
  // Served at /docs-json for the CI conformance gate, which diffs it against
  // 03_API_CONTRACT.yaml + the v3.1.0 overlay. Divergence fails the build.
  const openApiConfig = new DocumentBuilder()
    .setTitle('Zimmamless V3 API')
    .setDescription('Receivables marketplace connecting Jordanian suppliers with banks.')
    .setVersion('3.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearerAuth')
    .addGlobalParameters({
      name: 'X-Organization-Id',
      in: 'header',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description: 'Active organization context. Missing or non-member → 403.',
    })
    .addServer(`http://localhost:${config.port}/${config.globalPrefix}`, 'Local')
    .addServer('https://api.zimmamless.com/v1', 'Production')
    .build();

  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    yamlDocumentUrl: 'docs-yaml',
  });

  // Prime the time-machine guard before serving traffic, so the first
  // /auth/me reports the demo block correctly rather than one refresh late.
  await app.get(SystemTimeProvider).refresh();

  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');

  logger.event('info', 'API started', {
    port: config.port,
    prefix: config.globalPrefix,
    env: config.nodeEnv,
    timeMachineEnabled: config.demo.timeMachineEnabled,
    docs: `/docs-json`,
  });
}

bootstrap().catch((err) => {
  // Config validation and the database probe both throw here. Failing loudly
  // at boot is the point: a missing service-role key must not become a 500
  // on the first authenticated request.
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'API failed to start',
      error: (err as Error)?.message ?? String(err),
    }) + '\n',
  );
  process.exit(1);
});
