# Security implementation checklist

Status refers to reviewed/authored source, not executed checks. Human command output and deployed
configuration evidence are still required. Maintain this list as later authentication steps land.

## Implemented in Step 1

- [x] Canonical Akiba package/imports and supported local source dependency; no API-owned Prisma schema.
- [x] Remove fitness/commercial modules, their workers, DTOs and tests; preserve reusable authentication.
- [x] Typed catalog Problem Details, static approved text, correct statuses and safe database mappings.
- [x] Strict DTO validation; bounded approved nested field issues without payload/constraint disclosure.
- [x] Server-generated IDs before parsers/guards and structured completion/aborted/error observations.
- [x] Root logger projects reviewed fields; no arbitrary exception messages/stacks or optional log args.
- [x] Helmet, exact CORS, bounded parsers, explicit proxy trust, production TLS URL/secure cookie checks.
- [x] Production Swagger disabled; shutdown hooks; no startup migration or database call from errors.
- [x] Offline tests authored for HTTP validation/parser/rate-limit/error/log contracts.
- [x] Remove inherited production deployment automation; CI performs verification only.

## Reviewed and preserved

- [x] Password hashing, opaque credential digests, platform MFA, session expiry/revocation/live role reads.
- [x] Separate platform and owner guards/cookies, origin checks and mutation CSRF.
- [x] Trusted system-platform-owner policy; no client role or email-based authorization shortcut.
- [x] Owner membership narrowing and organization identity ownership checks; pending identity is read-only.
- [x] Organization lifecycle/ownership audits and conservative invitation uncertainty/release gates.
- [x] Canonical DB transaction lifecycle and composite relationship constraints inspected, not live-tested.

## Blocking risks, highest priority first

- [ ] **Critical — tenant isolation:** no enabled RLS/policies in akiba-db; TenantTransactionService sets
      context only. Managed owner may bypass RLS and can perform DDL/audit mutation. Verify actual role
      attributes/memberships/ownership and complete organization-scoped authorization/isolation evidence
      before live multi-tenant access. Do not silently introduce custom roles under the current policy.
- [ ] **High — organization authorization:** custom role-permission mappings, branch/resource policy,
      delegated grant constraints and cross-tenant mutation tests are incomplete. Propose required schema
      additions separately; a platform role never grants organization access.
- [ ] **High — browser/session boundary:** review shared API cookies, sibling-subdomain compromise,
      trusted tenant-origin selection, CSRF token delivery and BFF choice; exact origins require operator
      configuration. Domain examples are not proof of DNS control or production configuration.
- [ ] **High — operator/delivery boundary:** legacy bootstrap and invitation-worker restricted-role
      assumptions conflict with managed-owner policy. Keep bootstrap and delivery gates off. Do not run
      legacy live PostgreSQL tests, create test databases/roles or weaken role guards.
- [ ] **High — abuse controls:** process-local auth/global throttling is not a shared multi-instance
      control. Verify ingress client-IP trust, common atomic counters, recovery/send quotas and auth cost.
- [ ] **High — credential lifecycle:** complete protected recovery, factor enrollment/change, recent
      authentication, session rotation/all-session revocation and privacy/timing/one-time consumption tests.
- [ ] **High — audits:** complete durable security-event coverage, access/retention/attribution and
      tamper resistance; sanitized request logs are not security audit persistence.
- [ ] **Verification — dependency:** human rebuilds canonical DB, regenerates API package-lock and
      installs dependencies. Published registry artifact availability and clean CI install are unverified.
- [ ] **Verification — source:** human runs formatter, lint, typecheck, offline suites/E2E and build;
      resolve actual failures. Newly authored tests have not been executed by the agent.
- [ ] **Verification — operations:** verify deployed secrets, TLS/ingress, role privileges, sender,
      acceptance frontend, database compatibility, CI read-token and sanitized edge/proxy failures.

## Environment and live-test policy

Exactly two persistent Neon branches: development and production, using existing default databases
and managed owners. No new persistent test database, custom role, production test or startup migration.
API offline suites use mocks and unreachable test configuration. Live tests require the DB package's
guarded development mechanism, synthetic scoped fixtures/cleanup and an exclusive development window;
the inherited bootstrap PostgreSQL harness has not been adapted and stays disabled.

Step 2 readiness: suitable for continued controlled development after human dependency/build/test
verification. **Not ready for production multi-tenant access.** No live database, deployment, email,
package publication, Git write or validation command was executed in Step 1.
