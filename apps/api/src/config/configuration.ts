/**
 * Configuration is read once, validated at boot, and typed from here on.
 *
 * A missing SUPABASE_SERVICE_ROLE_KEY should stop the process at startup,
 * not surface as a 500 on the first authenticated request in front of a
 * judge. Every required variable is asserted below.
 */

/**
 * A class rather than an interface so it can serve as its own Nest DI token
 * (`constructor(private config: AppConfig)`) without a string-token
 * indirection that TypeScript cannot check.
 */
export class AppConfig {
  nodeEnv!: 'development' | 'test' | 'production';
  port!: number;
  globalPrefix!: string;
  logLevel!: 'debug' | 'info' | 'warn' | 'error';
  corsOrigins!: string[];
  database!: {
    url: string;
  };
  supabase!: {
    url: string;
    anonKey: string;
    /** Server-only. Bypasses RLS. Never serialized, never logged. */
    serviceRoleKey: string;
    /** Legacy HS256 projects only; blank means verify against the JWKS. */
    jwtSecret: string | null;
  };
  ml!: {
    url: string;
    timeoutMs: number;
  };
  demo!: {
    /** Env half of the two-part guard on the time machine. */
    timeMachineEnabled: boolean;
  };

  constructor(init: Omit<AppConfig, 'toJSON'>) {
    Object.assign(this, init);
  }

  /**
   * Guards against the service-role key reaching a log line or an error
   * body by way of an accidental serialization of config. Hard rule 8: the
   * key never leaves the server.
   */
  toJSON(): Record<string, unknown> {
    return {
      nodeEnv: this.nodeEnv,
      port: this.port,
      globalPrefix: this.globalPrefix,
      logLevel: this.logLevel,
      corsOrigins: this.corsOrigins,
      database: { url: '[REDACTED]' },
      supabase: {
        url: this.supabase.url,
        anonKey: '[REDACTED]',
        serviceRoleKey: '[REDACTED]',
        jwtSecret: '[REDACTED]',
      },
      ml: this.ml,
      demo: this.demo,
    };
  }
}

class ConfigError extends Error {}

function required(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable ${key}. See .env.example and docs/specs/ENVIRONMENTS.md.`,
    );
  }
  return value.trim();
}

function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function intOf(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new ConfigError(`Environment variable ${key} must be an integer, got "${raw}".`);
  return n;
}

export function loadConfiguration(): AppConfig {
  const nodeEnv = optional('NODE_ENV', 'development') as AppConfig['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ConfigError(`NODE_ENV must be development|test|production, got "${nodeEnv}".`);
  }

  const timeMachineEnabled = optional('DEMO_TIME_MACHINE_ENABLED', 'false') === 'true';

  // ZM-DEMO: the time machine must be impossible to enable in production,
  // and the failure must be loud at boot rather than a 404 discovered later.
  if (nodeEnv === 'production' && timeMachineEnabled) {
    throw new ConfigError(
      'DEMO_TIME_MACHINE_ENABLED=true with NODE_ENV=production. The demo time ' +
        'machine must never be enabled in production (ZM-DEMO-004). Refusing to start.',
    );
  }

  return new AppConfig({
    nodeEnv,
    port: intOf('PORT', 3000),
    // The contract's servers block is http://localhost:3000/v1.
    globalPrefix: optional('API_GLOBAL_PREFIX', 'v1'),
    logLevel: optional('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug') as AppConfig['logLevel'],
    corsOrigins: optional('CORS_ORIGINS', 'http://localhost:3001')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    database: {
      url: required('DATABASE_URL'),
    },
    supabase: {
      url: required('SUPABASE_URL'),
      anonKey: required('SUPABASE_ANON_KEY'),
      serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
      jwtSecret: process.env.SUPABASE_JWT_SECRET?.trim() || null,
    },
    ml: {
      url: optional('ML_SERVICE_URL', 'http://localhost:8000'),
      timeoutMs: intOf('ML_SERVICE_TIMEOUT_MS', 5000),
    },
    demo: {
      timeMachineEnabled,
    },
  });
}
