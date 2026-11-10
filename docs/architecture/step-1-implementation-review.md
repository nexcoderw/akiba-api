# Step 1 implementation review

Overall status: **PARTIALLY COMPLETE**. Source work is implemented; dependency resolution,
formatting, compilation, tests and build await human execution as requested. No production-readiness
claim is made. Inspection date: 2026-11-10.

## A. Repository inspection

The initial clean main checkout contained 335 tracked files, including 194 source and 73 test files.
Root AGENTS.md, CLAUDE.md and all topic instructions were read; nested instruction locations were
checked. The API is a NestJS 11 modular monolith with Express, strict TypeScript NodeNext/ESM,
class-validator/class-transformer, Jest/ts-jest, cookie sessions, Argon2id, TOTP, Resend and Prisma
through a separate database package. Existing auth, CSRF, session, permission, tenant, logging,
configuration, test and CI behavior was reviewed rather than assumed correct.

Reusable modules include platform authentication/MFA, sessions, permission guards, global dashboard,
organization registry/lifecycle/audits, owner sessions, enrollment/acceptance, portal identity and
invitation infrastructure. Existing auth endpoints were retained, not newly implemented. The old
filter echoed arbitrary HTTP exception text/details/path and client correlation IDs were accepted;
those disclosure and correlation weaknesses are corrected by the new transport foundation.

## B. Akiba rebranding

Package, canonical DB imports, cookies, service metadata, Swagger, examples, fixtures, rules and docs
now identify Akiba. Legal author attribution remains. Old cookie names no longer authenticate.
Removed members, membership plans, payments, fitness analytics, financial/PDF reports, reminders and
their workers, configurations, DTOs and obsolete tests/docs. Removed the inherited host-specific
production deploy script/job. Preserved reusable security and onboarding code and their relevant tests.
The old lockfile remains the only inherited dependency branding blocker until human npm regeneration.

## C. Database integration

Verified local public source: @nexcoderw/akiba-db 0.2.0, revision
71096ae94640e8227623d700e5c2fcb9a12007fb. Its 23 models/14 enums and public services match retained
identity/platform/organization/onboarding imports by static inspection. Supported file:../db resolution
is used, with CI pinning that source revision. Published registry availability and compiled API
compatibility are not verified. API package-lock.json was deliberately not edited by hand; npm must
regenerate it before npm ci/CI. No wildcard version or old package fallback is used.

DatabaseModule is registered once with injected validated ConfigService settings and shutdown hooks.
No duplicate schema/client generator, startup migration, DB source change, role or database was added.
TenantTransactionService sets transaction-local identifiers only; it provides no authorization/RLS.
The managed-owner/two-branch policy and no-RLS limitation remain explicit release blockers.

## D. Authentication foundation

[Authentication foundation](authentication-foundation.md) documents platform/organization boundaries,
global identity versus live membership, sessions/revocation, passwords, MFA/recovery, blocked bootstrap,
owner invitations, planned custom roles, tenant/branch/resource policy, audit, abuse controls,
cookies/CSRF, cross-subdomain threats and existing versus planned capabilities.

Platform system-owner policy remains a live trusted isSystem platform.owner assignment granting only
declared platform capabilities; it never grants organization access. Owner portal identity requires
current membership and organization-scoped owner role; pending status grants no business operations.
General organization permission mappings, branch authorization, protected recovery and full MFA
lifecycle still require subsequent work. No new full auth flow or frontend was introduced.

## E. Error handling and validation

ApiExceptionFilter emits top-level typed RFC 9457 application/problem+json using the central
api-error-code catalog. ApiProblemException carries only approved codes and sanitized field issues.
Unknown failures are generic 500; known status semantics and deliberate headers are preserved.
Parser errors, body limits, invalid encoding, throttling, conservative database conflicts/outages and
existing approved domain codes are normalized without exposing exception text or provider metadata.

ValidationPipe uses whitelist, forbidNonWhitelisted, forbidUnknownValues and explicit transformation
without implicit conversion. The custom factory emits approved messages, dot/index field paths and
bounded traversal/output: 20 issues, eight path segments, 128-character paths. Unexpected field names
become $. No values, raw constraints, targets, URL paths or arbitrary details are serialized.
[Frontend contract](../api/error-contract.md) explains migration from the old envelope, UI behavior,
privacy, session/outage/rate-limit handling and safe support references. OpenAPI reflects the contract.

## F. Security and performance

Server request IDs replace incoming values before parsers and guards. Request observations include
timestamp, method, framework route template/unmatched, status, code and duration; raw paths/queries,
payloads and credentials are excluded. A root logger projects reviewed fields and suppresses arbitrary
framework messages/stacks. Internal filter diagnostics are limited to safe database machine codes.

Helmet, exact credentialed CORS, exposed support/Retry-After headers, 32 KiB bounded parsers, explicit
proxy IP/CIDR trust and production HTTPS/secure cookie/TLS URL checks improve defaults. Production
Swagger remains disabled pending an authenticated docs boundary. Existing host-only cookies and
origin/CSRF/live membership checks remain. Error handling adds no database query.

The [security checklist](../security/security-checklist.md) separates authored, preserved, incomplete
and blocked controls. No RLS/live tenant guarantee, runtime least privilege, tamper-resistant audit or
shared multi-instance throttling was established. Bootstrap and invitation-worker legacy restricted
role assumptions conflict with the managed-owner policy; their gates stay disabled, with inert example
profiles and no provisioning instructions. Existing per-tenant CORS now needs explicit approved origins.

## G. Files changed

Created code: api-error-code.ts, api-problem.exception.ts, validation-issue.ts, request-observation.ts,
sanitized-logger.ts and request-logging.middleware.ts. Replaced the exception filter, error DTO,
validation factory and early request-ID middleware; updated app bootstrap/module/main, config,
canonical DB integration, Swagger and retained auth/domain imports/fixtures.

Created tests: API exception filter, sanitized logger and offline Problem Details HTTP probes.
Updated validation/config/workflow, OpenAPI and retained endpoint expectations. Created maintained
architecture, frontend contract, security checklist and this review; revised README, rules, runbooks,
ADRs, environment examples, package manifest and verification CI. Removed commercial module trees,
corresponding obsolete tests/docs/config/workers, old logging interceptor and deployment script.
The complete path inventory is recorded below, including deletions.

## H. Actual verification results

Executed only read-only inspection and file edits: git status/diff, rg/file reads and Python static
source/import/document/package inspection. git diff --check passed after removing trailing blank
lines. Static inspection found no missing relative imports, missing documentation links or unverified
retained public DB export names. akiba-db git status remained clean. These are not compiler/tests.

NOT RUN by the agent: npm install/ci, formatting, lint, typecheck, unit/integration/E2E tests, builds,
Prisma generation, server startup, live database tests, CI, email, migrations, Git writes or deployment.
No passing test/build result is asserted. CI now includes offline module integration tests with the
legacy PostgreSQL opt-in explicitly disabled. Human commands are in README; run them in order, then supply
actual failures. Offline suites use mocks; the incompatible opt-in PostgreSQL bootstrap suite remains
skipped. No production connection or additional persistent test database is permitted.

## I. Remaining issues in priority order

1. Critical: no proven tenant-isolation boundary; no RLS policies and administrative runtime owner.
2. High: missing organization permission mappings, branch/resource authorization and delegation checks.
3. High: browser/shared API/subdomain boundary, trusted portal origin registry and CSRF delivery review.
4. High: blocked operator/worker privilege design; keep inherited bootstrap/delivery gates off.
5. High: complete recovery/MFA/credential lifecycle, distributed abuse limits and durable security audit.
6. Verification: regenerate stale lock, resolve/build reviewed DB package, run human quality gates and
   verify private package publication, CI read token and clean install. Fix actual reported failures.
7. Operations: review actual role attributes, database compatibility, ingress/TLS, independent secrets,
   sender ownership and acceptance frontend before any release. No deployed control was certified.

## J. Step 2 readiness

**PARTIALLY COMPLETE**: the foundation source and maintained contracts are ready for human validation
and continued controlled work on Organization Isolation and Tenant Security. Do not mark Step 1
complete until the lockfile/install, security suites and build are verified by the human. Production
multi-tenant access stays blocked until isolation/authorization and privilege limitations are resolved
with evidence. Schema proposals belong in akiba-db; this task changed none of its files.

## Complete change inventory

### Created (13)

- `docs/api/error-contract.md`
- `docs/architecture/authentication-foundation.md`
- `docs/architecture/step-1-implementation-review.md`
- `docs/security/security-checklist.md`
- `src/common/errors/api-error-code.ts`
- `src/common/errors/api-problem.exception.ts`
- `src/common/errors/validation-issue.ts`
- `src/common/logging/request-observation.ts`
- `src/common/logging/sanitized-logger.ts`
- `src/common/middleware/request-logging.middleware.ts`
- `test/e2e/problem-details.e2e-spec.ts`
- `test/unit/api-exception.filter.spec.ts`
- `test/unit/sanitized-logger.spec.ts`

### Modified (139)

- `.agents/README.md`
- `.agents/authorization.md`
- `.agents/database-consumption.md`
- `.agents/dependencies.md`
- `.agents/error-handling.md`
- `.agents/feature-flags.md`
- `.agents/folder-structure.md`
- `.agents/git.md`
- `.agents/logging.md`
- `.agents/notifications.md`
- `.agents/subscriptions.md`
- `.agents/swagger.md`
- `.agents/tenant-isolation.md`
- `.agents/testing.md`
- `.env.bootstrap-test.local.example`
- `.env.bootstrap.local.example`
- `.env.local.example`
- `.env.production.example`
- `.github/workflows/ci-cd.yml`
- `.gitignore`
- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `docs/adr/0002-verified-tenant-context.md`
- `docs/adr/0003-database-package-boundary.md`
- `docs/api/api-conventions.md`
- `docs/architecture/feature-entitlements.md`
- `docs/architecture/module-boundaries.md`
- `docs/architecture/system-overview.md`
- `docs/architecture/tenant-resolution.md`
- `docs/runbooks/local-development.md`
- `docs/runbooks/platform-owner-bootstrap.md`
- `docs/runbooks/troubleshooting.md`
- `docs/security/platform-authentication.md`
- `docs/security/security-model.md`
- `package.json`
- `src/app-bootstrap.ts`
- `src/app.module.ts`
- `src/common/constants/api.constants.ts`
- `src/common/dto/api-error-response.dto.ts`
- `src/common/filters/api-exception.filter.ts`
- `src/common/middleware/request-id.middleware.ts`
- `src/common/pipes/validation-exception.factory.ts`
- `src/common/types/request-with-context.ts`
- `src/config/environment.types.ts`
- `src/config/environment.validation.ts`
- `src/config/owner-invitation-worker.environment.ts`
- `src/docs/swagger.ts`
- `src/infrastructure/database/database-integration.module.ts`
- `src/infrastructure/email/resend-email.service.ts`
- `src/infrastructure/email/resend-owner-invitation-email.service.ts`
- `src/main.ts`
- `src/modules/health/dto/liveness-response.dto.ts`
- `src/modules/owner/auth/dto/owner-auth-response.dto.ts`
- `src/modules/owner/auth/owner-auth.constants.ts`
- `src/modules/owner/auth/owner-auth.types.ts`
- `src/modules/owner/auth/owner-login.service.ts`
- `src/modules/owner/auth/owner-session.service.ts`
- `src/modules/owner/auth/owner-token.service.ts`
- `src/modules/owner/enrollment/dto/owner-enrollment-response.dto.ts`
- `src/modules/owner/enrollment/owner-acceptance.service.ts`
- `src/modules/owner/enrollment/owner-enrollment.service.ts`
- `src/modules/owner/owner.module.ts`
- `src/modules/owner/portal/dto/owner-dashboard-response.dto.ts`
- `src/modules/owner/portal/owner-portal.controller.ts`
- `src/modules/platform/auth/dto/platform-auth-response.dto.ts`
- `src/modules/platform/auth/platform-auth.constants.ts`
- `src/modules/platform/auth/platform-email-otp.service.ts`
- `src/modules/platform/auth/platform-login.service.ts`
- `src/modules/platform/auth/platform-mfa.service.ts`
- `src/modules/platform/auth/platform-session.service.ts`
- `src/modules/platform/auth/platform-totp.service.ts`
- `src/modules/platform/bootstrap/platform-bootstrap.constants.ts`
- `src/modules/platform/bootstrap/platform-owner-bootstrap.service.ts`
- `src/modules/platform/dashboard/dto/platform-dashboard-summary.dto.ts`
- `src/modules/platform/dashboard/platform-dashboard.controller.ts`
- `src/modules/platform/dashboard/platform-dashboard.service.ts`
- `src/modules/platform/organizations/dto/create-organization.dto.ts`
- `src/modules/platform/organizations/dto/list-organizations-query.dto.ts`
- `src/modules/platform/organizations/dto/organization-response.dto.ts`
- `src/modules/platform/organizations/platform-organization-audit.ts`
- `src/modules/platform/organizations/platform-organization-lifecycle.ts`
- `src/modules/platform/organizations/platform-organization-mapping.ts`
- `src/modules/platform/organizations/platform-organization-mutations.service.ts`
- `src/modules/platform/organizations/platform-organizations.service.ts`
- `src/modules/platform/owner-onboarding/dto/list-owner-invitations-query.dto.ts`
- `src/modules/platform/owner-onboarding/dto/owner-invitation-delivery.dto.ts`
- `src/modules/platform/owner-onboarding/dto/owner-invitation-response.dto.ts`
- `src/modules/platform/owner-onboarding/owner-invitation-delivery-worker.module.ts`
- `src/modules/platform/owner-onboarding/owner-invitation-delivery-worker.service.ts`
- `src/modules/platform/owner-onboarding/owner-invitation-delivery.policy.ts`
- `src/modules/platform/owner-onboarding/owner-invitation-delivery.service.ts`
- `src/modules/platform/owner-onboarding/owner-invitation-preview.controller.ts`
- `src/modules/platform/owner-onboarding/owner-invitation-token.service.ts`
- `src/modules/platform/owner-onboarding/platform-owner-invitation-audit.ts`
- `src/modules/platform/owner-onboarding/platform-owner-invitation-mapping.ts`
- `src/modules/platform/owner-onboarding/platform-owner-invitation-policy.ts`
- `src/modules/platform/owner-onboarding/platform-owner-onboarding.service.ts`
- `test/e2e/health.e2e-spec.ts`
- `test/e2e/owner-enrollment-acceptance.e2e-spec.ts`
- `test/e2e/owner-invitation-delivery.e2e-spec.ts`
- `test/e2e/platform-auth.e2e-spec.ts`
- `test/e2e/platform-dashboard.e2e-spec.ts`
- `test/e2e/platform-organizations.e2e-spec.ts`
- `test/e2e/platform-owner-onboarding.e2e-spec.ts`
- `test/fixtures/owner-invitation-delivery.fixture.ts`
- `test/fixtures/platform-dashboard-database.fixture.ts`
- `test/fixtures/platform-organizations-database.fixture.ts`
- `test/fixtures/platform-owner-onboarding-database.fixture.ts`
- `test/integration/owner-enrollment.integration.spec.ts`
- `test/integration/platform-auth.integration.spec.ts`
- `test/integration/platform-bootstrap-postgres.integration.spec.ts`
- `test/integration/platform-bootstrap.integration.spec.ts`
- `test/integration/platform-dashboard.integration.spec.ts`
- `test/integration/platform-organizations.integration.spec.ts`
- `test/integration/platform-owner-onboarding.integration.spec.ts`
- `test/integration/swagger.integration.spec.ts`
- `test/unit/environment-workflows.spec.ts`
- `test/unit/environment.validation.spec.ts`
- `test/unit/health.service.spec.ts`
- `test/unit/organization-portal-origin.spec.ts`
- `test/unit/owner-acceptance.service.spec.ts`
- `test/unit/owner-invitation-crypto.spec.ts`
- `test/unit/owner-invitation-delivery.spec.ts`
- `test/unit/owner-session.service.spec.ts`
- `test/unit/platform-bootstrap-database.spec.ts`
- `test/unit/platform-dashboard.service.spec.ts`
- `test/unit/platform-email-otp.service.spec.ts`
- `test/unit/platform-login.service.spec.ts`
- `test/unit/platform-mfa.service.spec.ts`
- `test/unit/platform-organizations-policy.spec.ts`
- `test/unit/platform-organizations.service.spec.ts`
- `test/unit/platform-owner-bootstrap.service.spec.ts`
- `test/unit/platform-owner-invitation-policy.spec.ts`
- `test/unit/platform-owner-onboarding.service.spec.ts`
- `test/unit/platform-permission-policy.spec.ts`
- `test/unit/platform-session.service.spec.ts`
- `test/unit/resend-owner-invitation-email.service.spec.ts`
- `test/unit/validation-exception.factory.spec.ts`

### Deleted (97)

- `docs/api/owner-dashboard-analytics.md`
- `docs/api/owner-payment-reports.md`
- `scripts/deploy-production.sh`
- `src/cli/member-reminder-delivery.ts`
- `src/cli/member-reminder-reconciler.ts`
- `src/common/interceptors/request-logging.interceptor.ts`
- `src/config/member-reminder-database.environment.ts`
- `src/config/member-reminder-reconciler.environment.ts`
- `src/config/member-reminder-worker.environment.ts`
- `src/infrastructure/email/resend-member-reminder-email.service.ts`
- `src/infrastructure/email/resend-member-reminder-status.service.ts`
- `src/modules/owner/dashboard/dto/owner-dashboard-analytics.dto.ts`
- `src/modules/owner/dashboard/owner-dashboard-analytics-mapping.ts`
- `src/modules/owner/dashboard/owner-dashboard-analytics.controller.ts`
- `src/modules/owner/dashboard/owner-dashboard-analytics.module.ts`
- `src/modules/owner/dashboard/owner-dashboard-analytics.policy.ts`
- `src/modules/owner/dashboard/owner-dashboard-analytics.service.ts`
- `src/modules/owner/list-date-range.ts`
- `src/modules/owner/members/dto/create-member.dto.ts`
- `src/modules/owner/members/dto/list-members.dto.ts`
- `src/modules/owner/members/dto/member-response.dto.ts`
- `src/modules/owner/members/dto/register-member-subscription.dto.ts`
- `src/modules/owner/members/dto/update-member.dto.ts`
- `src/modules/owner/members/member-normalization.ts`
- `src/modules/owner/members/member-period.ts`
- `src/modules/owner/members/member-plan-registration.ts`
- `src/modules/owner/members/owner-member-context.ts`
- `src/modules/owner/members/owner-member-errors.ts`
- `src/modules/owner/members/owner-member-mapping.ts`
- `src/modules/owner/members/owner-members.controller.ts`
- `src/modules/owner/members/owner-members.module.ts`
- `src/modules/owner/members/owner-members.service.ts`
- `src/modules/owner/membership-plans/dto/create-membership-plan.dto.ts`
- `src/modules/owner/membership-plans/dto/list-membership-plans-query.dto.ts`
- `src/modules/owner/membership-plans/dto/membership-plan-list-response.dto.ts`
- `src/modules/owner/membership-plans/dto/membership-plan-response.dto.ts`
- `src/modules/owner/membership-plans/dto/update-membership-plan.dto.ts`
- `src/modules/owner/membership-plans/owner-membership-plan-context.ts`
- `src/modules/owner/membership-plans/owner-membership-plan-errors.ts`
- `src/modules/owner/membership-plans/owner-membership-plan-mapping.ts`
- `src/modules/owner/membership-plans/owner-membership-plan-precondition.ts`
- `src/modules/owner/membership-plans/owner-membership-plans.constants.ts`
- `src/modules/owner/membership-plans/owner-membership-plans.controller.ts`
- `src/modules/owner/membership-plans/owner-membership-plans.module.ts`
- `src/modules/owner/membership-plans/owner-membership-plans.service.ts`
- `src/modules/owner/payments/dto/create-payment.dto.ts`
- `src/modules/owner/payments/dto/list-payments-query.dto.ts`
- `src/modules/owner/payments/dto/payment-command.dto.ts`
- `src/modules/owner/payments/dto/payment-response.dto.ts`
- `src/modules/owner/payments/dto/register-payment.dto.ts`
- `src/modules/owner/payments/owner-payment-context.ts`
- `src/modules/owner/payments/owner-payment-errors.ts`
- `src/modules/owner/payments/owner-payment-mapping.ts`
- `src/modules/owner/payments/owner-payments.controller.ts`
- `src/modules/owner/payments/owner-payments.module.ts`
- `src/modules/owner/payments/owner-payments.service.ts`
- `src/modules/owner/reminders/dto/reminder-activity.dto.ts`
- `src/modules/owner/reminders/member-reminder-delivery.module.ts`
- `src/modules/owner/reminders/member-reminder-delivery.service.ts`
- `src/modules/owner/reminders/member-reminder-reconciler.module.ts`
- `src/modules/owner/reminders/member-reminder-reconciler.service.ts`
- `src/modules/owner/reminders/owner-reminder-activity.controller.ts`
- `src/modules/owner/reminders/owner-reminder-activity.module.ts`
- `src/modules/owner/reminders/owner-reminder-activity.service.ts`
- `src/modules/owner/reminders/owner-reminder-context.ts`
- `src/modules/owner/reports/dto/payment-report.dto.ts`
- `src/modules/owner/reports/owner-payment-reports.controller.ts`
- `src/modules/owner/reports/owner-payment-reports.module.ts`
- `src/modules/owner/reports/owner-payment-reports.service.ts`
- `src/modules/owner/reports/payment-report-pdf.ts`
- `src/modules/owner/reports/payment-report-policy.ts`
- `test/e2e/owner-dashboard-analytics.e2e-spec.ts`
- `test/e2e/owner-members.e2e-spec.ts`
- `test/e2e/owner-membership-plans.e2e-spec.ts`
- `test/e2e/owner-payment-reports.e2e-spec.ts`
- `test/e2e/owner-payments.e2e-spec.ts`
- `test/e2e/owner-reminder-activity.e2e-spec.ts`
- `test/integration/owner-dashboard-analytics-postgres.integration.spec.ts`
- `test/unit/list-date-range.spec.ts`
- `test/unit/member-period.spec.ts`
- `test/unit/member-reminder-delivery.spec.ts`
- `test/unit/member-reminder-reconciler.spec.ts`
- `test/unit/owner-dashboard-analytics-mapping.spec.ts`
- `test/unit/owner-dashboard-analytics.policy.spec.ts`
- `test/unit/owner-dashboard-analytics.service.spec.ts`
- `test/unit/owner-members-pagination.spec.ts`
- `test/unit/owner-members-registration.spec.ts`
- `test/unit/owner-membership-plans-policy.spec.ts`
- `test/unit/owner-payment-registration.spec.ts`
- `test/unit/owner-payment-reports.service.spec.ts`
- `test/unit/owner-persisted-uuid-validation.spec.ts`
- `test/unit/owner-reminder-activity.spec.ts`
- `test/unit/owner-upcoming-reminders.spec.ts`
- `test/unit/payment-report-pdf.spec.ts`
- `test/unit/payment-report-policy.spec.ts`
- `test/unit/resend-member-reminder-email.service.spec.ts`
- `test/unit/resend-member-reminder-status.service.spec.ts`
