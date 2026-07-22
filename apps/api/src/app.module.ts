import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfig, loadConfiguration } from './config/configuration';
import { DatabaseService } from './database/database.service';
import { AppLogger } from './common/logging/app-logger.service';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AuditService } from './common/audit/audit.service';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { TIME_PROVIDER, SystemTimeProvider } from './common/time/time.provider';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthService } from './modules/auth/auth.service';
import { AuthController } from './modules/auth/auth.controller';
import { JwtVerifierService } from './modules/auth/jwt-verifier.service';
import { HealthController } from './modules/health/health.controller';

export const APP_CONFIG = 'APP_CONFIG';

/**
 * Single root module.
 *
 * Phase 1 is small enough that per-feature modules would be ceremony; the
 * layout in brief §3 (modules/auth, modules/organizations, …) is followed as
 * a directory structure and split into Nest modules as each phase adds one.
 *
 * Everything cross-cutting is registered globally here rather than per
 * controller, because each is a rule that must hold everywhere:
 *   - AuthGuard        every route authenticates and establishes org context
 *   - AuditInterceptor every mutation is audited (hard rule 6)
 *   - ExceptionFilter  every error uses the contract's Error envelope
 */
@Global()
@Module({
  controllers: [AuthController, HealthController],
  providers: [
    {
      provide: AppConfig,
      useFactory: loadConfiguration,
    },
    { provide: APP_CONFIG, useExisting: AppConfig },

    AppLogger,
    DatabaseService,
    AuthService,
    JwtVerifierService,
    AuditService,

    // The env half of the time machine's two-part guard, injected so the
    // provider cannot read process.env directly and drift from config
    // validation (which refuses to boot with it true in production).
    {
      provide: 'DEMO_TIME_MACHINE_ENV_FLAG',
      useFactory: (config: AppConfig) => config.demo.timeMachineEnabled,
      inject: [AppConfig],
    },
    {
      provide: TIME_PROVIDER,
      useClass: SystemTimeProvider,
    },
    SystemTimeProvider,

    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [AppConfig, APP_CONFIG, DatabaseService, AppLogger, AuditService, TIME_PROVIDER],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // First in the chain: everything downstream, including the guard's
    // rejections, needs the correlation id to already exist.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
