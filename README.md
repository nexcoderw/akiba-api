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

## Tenant security

Every HTTP route declares an access boundary. Unclassified routes and protected declarations missing
the required real guards are denied. Public credential handlers still retain their origin/CSRF,
validation and abuse controls. Platform permissions never authorize organization access.
Platform business services require the exact server-issued principal and recheck live session, account,
MFA and declared permissions before reading or mutating records. Audit actors must match that principal;
internal callers cannot authorize themselves by supplying an actor UUID or copied identity.

Set API_PUBLIC_ORIGIN to the actual shared API origin, and list each approved portal in CORS_ORIGINS.
Organization requests validate both the request authority and approved portal Origin; neither grants
membership. Forwarded hosts are used only from explicitly trusted proxy addresses and must be a single
approved authority. Unknown, reserved, nested or mismatched domains fail closed. Verified custom domains
need a future registry and are not supported. For local tenant routing, replace the fixed
ORGANIZATION_PORTAL_ORIGIN with ORGANIZATION_PORTAL_BASE_DOMAIN=akiba.localhost and list exact local
portal origins such as http://musomesa.akiba.localhost:4001. Production rejects local base domains.
A shared localhost frontend without a tenant label cannot silently select an organization by route ID.

Owner browser credentials are authenticated for one portal Origin. Old unsigned cookies require a new
sign-in; changing the Origin cannot replay them at a sibling portal, including for multi-organization
users. Cookies remain host-only on the shared API, with no parent-domain cookie. The current single
cookie name means signing into another portal replaces the active browser credential; simultaneous
portal sessions need a separately reviewed cookie/BFF design.

TenantAuthorizationService issues immutable, per-request contexts from live session membership,
ignoring tenant headers, body fields and client role claims. TenantPortalService accepts only issued
contexts, scopes the existing identity read by organization/membership/user, and rechecks active state,
password/session revocation and the system owner role inside a tenant transaction. PENDING organizations
now receive the same safe denial as other unavailable organizations. Only the explicit TenantIdentityRead capability is supported; other tenant reads default deny.
No broad owner capability is introduced. Resource condition builders always retain the trusted organization. Permissioned writes,
custom roles, nested/bulk mutations and branch operations fail closed until their mappings exist.

Persistence ownership remains distinct: User/PasswordCredential/OwnerSession are user-global security
records; PlatformStaff, platform roles/permissions, MFA/sessions and authorization audits are platform
security records; Organization is the platform-managed tenant root; memberships, organization roles,
invitations, deliveries, enrollment and organization/ownership/acceptance audits are scoped associations.
Composite keys protect cross-organization assignments. Branch and organization permission mappings are
still absent. Transaction-local settings are not row filtering or authorization.

The DB transaction helper snapshots scope and rejects nested tenant transactions; reuse the callback
client within one operation. Existing guarded DB suites cover physical pool cleanup/rollback/concurrency
and composite constraints; API tests use offline adapters and do not prove those live properties.
No live role audit was executed. Database-enforced isolation remains BLOCKED under the current no-RLS,
managed-owner policy; BYPASSRLS is not constrained by FORCE RLS. A production alternative requires a
separately approved least-privilege runtime identity and reviewed policies, not automatically created
roles. In api/db, the human may run npm run security:tenant:audit for read-only development evidence.
The API CI source pin must be updated to the verified DB fix commit before release.
