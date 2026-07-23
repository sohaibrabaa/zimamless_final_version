import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfig, loadConfiguration } from './config/configuration';
import { DatabaseService } from './database/database.service';
import { AppLogger } from './common/logging/app-logger.service';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AuditService } from './common/audit/audit.service';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { LedgerService } from './modules/ledger/ledger.service';
import { OtpService } from './modules/funding/otp.service';
import { FundingService } from './modules/funding/funding.service';
import { FundingController } from './modules/funding/funding.controller';
import { TIME_PROVIDER, SystemTimeProvider } from './common/time/time.provider';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthService } from './modules/auth/auth.service';
import { AuthController } from './modules/auth/auth.controller';
import { JwtVerifierService } from './modules/auth/jwt-verifier.service';
import { HealthController } from './modules/health/health.controller';
import { OnboardingController } from './modules/onboarding/onboarding.controller';
import { OnboardingService } from './modules/onboarding/onboarding.service';
import { SlaClockService } from './modules/onboarding/sla-clock.service';
import { GovernmentController } from './modules/government/government.controller';
import { GovernmentService } from './modules/government/government.service';
import { GOVERNMENT_ADAPTERS } from './modules/government/government-adapter';
import { CcdAdapter, GamAdapter, IstdAdapter } from './modules/government/dummy-adapters';
import {
  DEFAULT_RESILIENCE,
  ResilientGovernmentAdapter,
} from './modules/government/resilient-adapter';
import { BuyersController } from './modules/buyers/buyers.controller';
import { BuyersService } from './modules/buyers/buyers.service';
import { DocumentsController } from './modules/documents/documents.controller';
import { DocumentsService } from './modules/documents/documents.service';
import { StorageService } from './modules/documents/storage.service';
import { MlClientService } from './modules/documents/ml-client.service';
import { TransactionsController } from './modules/transactions/transactions.controller';
import { TransactionsService } from './modules/transactions/transactions.service';
import { AdminRiskModelsController, RiskController } from './modules/risk/risk.controller';
import { RiskService } from './modules/risk/risk.service';
import { RiskModelsService } from './modules/risk/risk-models.service';
import { RiskModelClientService } from './modules/risk/risk-model-client.service';
import { MarketplaceController, OffersController } from './modules/marketplace/marketplace.controller';
import { ListingsService } from './modules/marketplace/listings.service';
import { OffersService } from './modules/marketplace/offers.service';
import { PolicyFiltersService } from './modules/marketplace/policy-filters.service';
import { CommissionService } from './modules/marketplace/commission.service';
import { ListingDeadlinesService } from './modules/marketplace/listing-deadlines.service';
import {
  AcceptanceController,
  ContractsController,
} from './modules/contracts/contracts.controller';
import { AcceptanceService } from './modules/contracts/acceptance.service';
import { ContractsService } from './modules/contracts/contracts.service';
import { ConditionsService } from './modules/contracts/conditions.service';
import {
  DummySignatureProvider,
  SIGNATURE_PROVIDER,
} from './modules/contracts/signature.provider';

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
  controllers: [
    AuthController,
    HealthController,
    OnboardingController,
    GovernmentController,
    // --- Phase 3 ---
    BuyersController,
    DocumentsController,
    TransactionsController,
    RiskController,
    AdminRiskModelsController,
    MarketplaceController,
    OffersController,
    // --- Phase 6 ---
    AcceptanceController,
    ContractsController,
    // --- Phase 7 ---
    FundingController,
  ],
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
    // useExisting, not useClass: useClass would construct a *second*
    // SystemTimeProvider with its own cache, so priming at boot and calling
    // refresh() on the demo controller would act on an instance no injection
    // site ever sees.
    SystemTimeProvider,
    {
      provide: TIME_PROVIDER,
      useExisting: SystemTimeProvider,
    },

    // --- Phase 2: onboarding and government -----------------------------
    OnboardingService,
    SlaClockService,
    GovernmentService,
    CcdAdapter,
    IstdAdapter,
    GamAdapter,
    /**
     * Each dummy adapter is wrapped in the retry/timeout/circuit-breaker
     * layer here rather than inside the adapters themselves. ZM-GOV-009
     * requires that swapping a dummy for a production adapter change no
     * domain logic — so resilience has to live outside the thing being
     * swapped, and every adapter gets identical treatment by construction.
     */
    {
      provide: GOVERNMENT_ADAPTERS,
      useFactory: (ccd: CcdAdapter, istd: IstdAdapter, gam: GamAdapter, time: { nowMs(): number }) =>
        [ccd, istd, gam].map(
          (adapter) =>
            new ResilientGovernmentAdapter(adapter, DEFAULT_RESILIENCE, () => time.nowMs()),
        ),
      inject: [CcdAdapter, IstdAdapter, GamAdapter, TIME_PROVIDER],
    },

    // --- Phase 3: buyers, documents, transactions -----------------------
    BuyersService,
    StorageService,
    MlClientService,
    DocumentsService,
    TransactionsService,
    RiskModelsService,
    RiskModelClientService,
    RiskService,
    CommissionService,
    ListingsService,
    OffersService,
    PolicyFiltersService,
    ListingDeadlinesService,

    // --- Phase 6: selection, contracts, signatures ----------------------
    AcceptanceService,
    ContractsService,
    ConditionsService,

    // --- Phase 7: funding, settlement, ledger --------------------------
    // The ledger is registered first because everything else in this phase
    // posts to it. It holds no state of its own — `post()` takes the caller's
    // PoolClient so a journal commits with the settlement or commission row it
    // describes, never separately.
    LedgerService,
    FundingService,
    OtpService,
    // The provider is bound to a symbol, not to its class, so ZM-CON-009's
    // "insertable without core domain changes" is a one-line swap here and
    // nothing else. Nothing outside this file names DummySignatureProvider.
    DummySignatureProvider,
    { provide: SIGNATURE_PROVIDER, useExisting: DummySignatureProvider },

    { provide: APP_GUARD, useClass: AuthGuard },
    // Idempotency is registered BEFORE audit so it is the outer interceptor:
    // a replayed key short-circuits here and no second audit row is written.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
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
