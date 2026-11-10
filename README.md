# Akiba API

NestJS 11 / TypeScript ESM API. `@nexcoderw/akiba-db` owns the Prisma schema, migrations and connection
lifecycle. Build the sibling `api/db` package before installing or building this repository.

## Environment

Use only the existing development and production Neon branches, their default database and managed
owner. Development loads `.env.local`; an explicitly selected `NODE_ENV=production` loads optional
`.env.production`, with injected secrets taking precedence. Copy the corresponding `.example` file
and fill secrets privately. The API needs only the pooled `DATABASE_URL`; direct migration connections
and guarded live database checks remain in `api/db`. No separate database or role is provisioned here.

Offline unit, module and HTTP tests replace the database module with fakes. `NODE_ENV=test` loads no
environment file, keeps no database URL and cannot initialize a real database pool. It describes the
test process, not another database environment.

The existing operator bootstrap uses the selected runtime connection. It stays disabled by default;
explicit enablement, interactive host/database/user confirmation, live identity checks, transaction
locking, first-owner checks and MFA activation remain required. Invitation delivery retains its
separate release approvals and database integrity checks and stays disabled by default.

## Human verification

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Run `npm run start:dev` only after configuring the development environment. The API never applies
migrations at startup. Agents edit and inspect files; humans execute checks and Git writes.

## HTTP contract

Routes use `/api/v1`. `/api/v1/health/live` reports process liveness, not database readiness.
Development OpenAPI is available at `/docs`; production Swagger stays disabled. OpenAPI definitions
remain executable source under `src/docs/`. No separate documentation/report directory is maintained.

Failures use `application/problem+json` with approved `type`, `title`, `status`, `detail`, `code`,
server-generated `requestId` and optional bounded field `errors`. Match stable codes in clients and
render approved messages as text; do not display raw backend objects. Request IDs also appear in
`X-Request-Id`. Logs exclude bodies, query strings, credentials and raw exception messages/stacks.

Platform and organization sessions retain separate host-only cookies, origin/CSRF checks and live
permission/membership validation. Exact credentialed CORS is not authorization. Managed-owner
privileges and the current absence of RLS do not establish production tenant isolation; complete
organization permission/branch policies, shared abuse controls and security auditing still need work.
