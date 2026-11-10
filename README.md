# Akiba API

NestJS 11 / TypeScript ESM API foundation for Akiba Inventory Management. Express 5 handles HTTP;
`@nexcoderw/akiba-db` owns PostgreSQL, Prisma models, migrations and pool lifecycle.

Step 1 rebrands the cloned foundation, removes inherited fitness business modules and establishes
safe errors, strict validation, request correlation and security documentation. Existing platform/owner
authentication, MFA, sessions, organization registry and onboarding source is preserved. No new full
authentication or inventory workflow was added. Installation, formatting, tests and build remain
human-run and unverified. Live multi-tenant production access is blocked by the security checklist.

## Documents

- [Step 1 completion report](docs/architecture/step-1-implementation-review.md)
- [Authentication foundation and inspection findings](docs/architecture/authentication-foundation.md)
- [Frontend Problem Details contract](docs/api/error-contract.md)
- [Security checklist and release blockers](docs/security/security-checklist.md)
- [Module boundaries](docs/architecture/module-boundaries.md)
- [Local development](docs/runbooks/local-development.md)
- [Blocked legacy bootstrap](docs/runbooks/platform-owner-bootstrap.md)

## Dependency and environment preparation

Use Node 22.12+ within the supported engine range and npm 10+. Keep sibling checkouts at `api/db` and
`api/api`. Verified local DB: version 0.2.0, revision
`71096ae94640e8227623d700e5c2fcb9a12007fb`. The API uses supported `file:../db` resolution; CI pins that
source revision. No published artifact was verified. The old API lockfile is intentionally untouched
because agents may not fabricate lockfiles; regenerate it with npm before npm ci or committing.

Human commands, run in order from the appropriate repository:

```bash
cd /Users/test/Desktop/project/akiba/api/db
npm ci
npm run prisma:generate
npm run build

cd /Users/test/Desktop/project/akiba/api/api
npm install --package-lock-only
npm ci --include=dev
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

These generation/build/test commands do not apply migrations. The default test suite includes offline
unit/module/HTTP suites; the incompatible legacy live bootstrap suite stays skipped. Never enable
BOOTSTRAP_POSTGRES_TESTS under the current database policy. CI currently runs formatting, lint, types,
unit, offline module, HTTP and build checks; it needs DB_REPOSITORY_READ_TOKEN and the regenerated lockfile.

For a local server, manually copy `.env.local.example` to ignored `.env.local`, fill the approved
existing development pooled Neon URL and independently generated secret keys, then run
`npm run start:dev`. Do not print or commit credentials. Test/production ignore dotenv files;
production requires injected configuration, HTTPS origins, secure cookies and Swagger disabled.

Use only the existing default database/managed owner in the development and production Neon branches.
No extra persistent database/custom role is allowed. Runtime never migrates automatically; database
changes follow akiba-db's separately guarded workflow. Managed-owner use is a known isolation risk,
not a least-privilege runtime design. Bootstrap/delivery gates remain disabled pending redesign.

## Transport and security behavior

Routes retain `/api/v1`; process liveness is `/api/v1/health/live`, not dependency readiness. Development
Swagger is `/docs`. Error responses use application/problem+json with approved top-level
`type`, `title`, `status`, `detail`, `code`, `requestId` and optional sanitized `errors`.
This replaces the old nested error envelope. Client request IDs are replaced on every request.

Correlation/logging precede parsers and guards. Helmet, 32 KiB default body limit, exact credentialed
CORS, explicit IP/CIDR proxy trust, strict DTO validation and process-local throttling establish the
transport baseline. No bodies, query strings, route values, exception messages/stacks or credential
material are logged. The root logger projects approved structured fields only.

Platform/owner cookies have separate Akiba names and host-only scope; old cookie names no longer
authenticate. Membership, role, organization status, origin and CSRF checks remain necessary even when
CORS accepts a request. Each tenant frontend origin must be explicitly reviewed/listed; base-domain
syntax alone no longer enables CORS. Deployment/domain examples are illustrative.

## Removed scope and remaining work

Removed members, membership plans, payments, fitness analytics, reports/PDF generation, reminders and
their obsolete source/tests/configurations, plus inherited host-specific deployment automation.
Canonical schema/migrations and reusable authentication/onboarding code remain in their owning repos.

No RLS policy, complete organization permission mapping, branch model or full recovery workflow exists
in the inspected DB package. Administrative runtime privileges, browser/subdomain boundaries,
distributed throttling, bootstrap/worker role compatibility, durable audits and live authorization
proof block production approval. Continue Step 2 as controlled development after human validation;
track evidence in the maintained checklist rather than assuming test success implies isolation.
