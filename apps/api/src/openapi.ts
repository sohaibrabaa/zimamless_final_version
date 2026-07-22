import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi.config';

/**
 * Emits the served OpenAPI document to a file, without listening and without
 * a database.
 *
 *   ZM_SPEC_ONLY=true node dist/openapi.js <output-path>
 *
 * The contract-conformance gate (scripts/contract-conformance.mjs) diffs the
 * result against 03_API_CONTRACT.yaml + the v3.1.0 overlay. Emitting from
 * the real module graph — rather than from a hand-maintained list — is what
 * makes the gate meaningful: it sees exactly the routes Nest registered.
 */
async function emit(): Promise<void> {
  const outputPath = process.argv[2] ?? 'openapi.generated.json';

  // Nest still instantiates providers; DatabaseService honours ZM_SPEC_ONLY
  // and skips its connection probe.
  process.env.ZM_SPEC_ONLY = 'true';

  // Config validation asserts every required variable at boot, which is
  // right for the server and wrong here: emitting a route list needs no
  // credentials, and requiring them would mean the conformance gate could
  // only run where production secrets are available. Placeholders are used
  // ONLY for variables that are still unset, so a real environment is never
  // overridden, and ZM_SPEC_ONLY keeps them from reaching anything live.
  const placeholders: Record<string, string> = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://spec:spec@localhost:5432/spec',
    SUPABASE_URL: 'https://spec.supabase.co',
    SUPABASE_ANON_KEY: 'spec-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'spec-service-role-key',
  };
  for (const [key, value] of Object.entries(placeholders)) {
    if (!process.env[key]) process.env[key] = value;
  }

  // Errors are kept visible: `logger: false` silences Nest's
  // ExceptionHandler, which turns any bootstrap failure into a bare exit 1
  // with no diagnostic at all.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix(process.env.API_GLOBAL_PREFIX ?? 'v1', { exclude: ['health'] });
  await app.init();

  const document = buildOpenApiDocument(app);
  writeFileSync(outputPath, JSON.stringify(document, null, 2));

  await app.close();
  process.stdout.write(`Wrote ${outputPath}\n`);
}

emit().catch((err) => {
  // process.exitCode, not process.exit(): on Windows, exit() truncates
  // pending writes to a pipe, so the diagnostic that explains the failure is
  // exactly what gets lost. Setting the code lets Node drain and exit
  // naturally.
  console.error(`Failed to emit OpenAPI document: ${(err as Error)?.stack ?? String(err)}`);
  process.exitCode = 1;
});
