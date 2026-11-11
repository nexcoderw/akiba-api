# Akiba API

NestJS 11 / TypeScript ESM API. `@nexcoderw/akiba-db` owns the Prisma schema, migrations and connection
lifecycle. Build the sibling `api/db` package before installing or building this repository.

## Environment

Use only the existing development and production Neon branches, their default database and managed
owner. Development loads `.env.local`; an explicitly selected `NODE_ENV=production` loads optional
`.env.production`, with injected secrets taking precedence. Copy the corresponding `.example` file
and fill secrets privately. The examples use `sslmode=verify-full` for explicit certificate and
hostname verification. The API needs only the pooled `DATABASE_URL`; direct migration connections
and guarded live database checks remain in `api/db`. No separate database or role is provisioned here.

Offline unit, module and HTTP tests replace the database module with fakes. `NODE_ENV=test` loads no
environment file, keeps no database URL and cannot initialize a real database pool. It describes the
test process, not another database environment.

The operator-only first-owner command stays disabled by default. Initialization requires an explicit
`NODE_ENV` and matching command target, interactive host/database/user and email confirmation, a
live database identity check, and a transaction lock. It reserves one pending global identity and
platform staff record with the protected owner role, with no password, verified email, MFA factor,
or session. A pending or disabled staff record still blocks another initialization. Never run this
command against a live branch without an approved owner and reviewed recovery plan: reservation is
one-time and currently cannot be completed. Compare the displayed host against the separately
approved Neon branch registry before confirming; the SQL check verifies the connected database and
role, but it cannot independently prove Neon branch ownership.

The old activation path trusted an operator-typed mailbox assertion. It is now closed. The
`bootstrap:platform-owner:activate` command fails with `BOOTSTRAP_ENROLLMENT_UNAVAILABLE` until
mailbox-proof delivery and consumption, proof-bound password setup, verified MFA enrollment,
bounded attempts and transactional activation are implemented and tested. Do not mark the pending
identity active or set `email_verified_at` manually. Future loss of owner access requires a
separately authorized governance/recovery procedure; it must not reopen initialization. The
database-managed owner connection and absent RLS policies remain a separate production isolation
blocker. Invitation delivery retains its separate release approvals and stays disabled by default.
Any pending owner reserved by the older command may already have a password and an unverified TOTP
factor; leave it pending for a separately reviewed enrollment repair. Any owner previously
activated through the old mailbox assertion needs a separate security review; this change does
not retroactively prove mailbox ownership or revoke an existing session.

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
now receive the same safe denial as other unavailable organizations. The existing owner dashboard
continues to use its explicit TenantIdentityRead capability. Future permissioned handlers declare a
typed RequireOrganizationPermission capability; undeclared tenant handlers still default deny.
Resource condition builders always retain the trusted organization.

Persistence ownership remains distinct: User/PasswordCredential are user-global security
records; OwnerSession is bound to one organization membership or a verified enrollment proof;
PlatformStaff, platform roles/permissions, MFA/sessions and authorization audits are platform
security records; Organization is the platform-managed tenant root; memberships, organization roles,
invitations, deliveries, enrollment and organization/ownership/acceptance audits are scoped associations.
Composite keys protect cross-organization assignments and role-permission mappings. The organization
permission catalog is version controlled in `akiba-db`; no tenant-defined capability strings are
accepted. Multiple active custom roles contribute a positive union of declared grants for the selected
organization only. Inactive roles, unknown permissions, and system-role lookalikes grant nothing.
The trusted system owner role receives the organization catalog, while owner-only capabilities cannot
be delegated through custom-role mappings. The owner-only capability is withheld unless the live
session has AAL2 with an MFA verification timestamp; no current management workflow invokes it.
Platform grants never enter this union.

OrganizationAuthorizationService rechecks live session, global account, credential, organization and
membership state and loads current role mappings. There is no permission cache, so committed role or
membership changes take effect on the next check. Resource scopes are explicit: organization-wide
checks use the issued organization; branch checks deny until verified branch membership exists.
OrganizationAccessManagementService exposes internal-only custom-role creation, detail and permission changes,
role disablement, assignment and ordinary membership state changes. Each operation locks the tenant
root, checks current actor grants in the same transaction, constrains delegation to the actor's
effective permissions, uses authorization versions, and writes an append-only actor audit. Owner-role
assignment/removal and owner membership suspension/revocation are denied in this service. Owner
enrollment remains the only existing path for protected owner assignment. No member invitation,
owner transfer, owner MFA step-up, public role editor or branch policy is exposed yet. Error responses
use the existing safe problem catalog; internal database exceptions are not reflected in public text.
Transaction-local settings are not row filtering or authorization.

The DB transaction helper snapshots scope and rejects nested tenant transactions; reuse the callback
client within one operation. Existing guarded DB suites cover physical pool cleanup/rollback/concurrency
and composite constraints; API tests use offline adapters and do not prove those live properties.
No live role audit was executed. Database-enforced isolation remains BLOCKED under the current no-RLS,
managed-owner policy; BYPASSRLS is not constrained by FORCE RLS. A production alternative requires a
separately approved least-privilege runtime identity and reviewed policies, not automatically created
roles. In api/db, the human may run npm run security:tenant:audit for read-only development evidence.
The API CI repository variable AKIBA_DB_SOURCE_REVISION must contain the reviewed DB commit before
release. CI validates the full commit hash before checkout and never falls back to a branch.

## Step 5 session foundation

Platform and organization sessions use separate opaque 32-byte random tokens and keyed SHA-256
digests. Cookies are HttpOnly, Secure in production, SameSite Strict, Path `/`, and host-only;
their CSRF companions are readable for the exact-origin double-submit header. Login and MFA
transitions issue fresh cookies and CSRF values. The server checks idle and absolute deadlines,
current account and credential state, and live platform permissions or the bound organization
membership on each protected request. Activity writes are coalesced. Token lookup uses a unique
digest index. Tokens, digests and cookies are never returned by session-listing methods.

An owner login creates a session for the single selected active owner membership. A user with
multiple owner memberships must sign in from a tenant-specific approved portal Origin. Enrollment
verification instead creates a short-lived provisional session bound to its verified challenge.
That session can only reach invitation acceptance; acceptance consumes the challenge and clears
the provisional cookie. The user signs in again to obtain a full membership-bound session.
The Step 5 migration revokes all prior unbound owner sessions, so existing browsers must also
sign in again. Apply the reviewed DB migration and regenerate/build `api/db` before running this API.

Internal owner session methods can list at most 20 safe session summaries, revoke a selected or
other session within the caller's own membership, and atomically replace a full session token.
Rotation preserves the original absolute deadline and authentication evidence; the old token is
revoked in the same transaction. Platform internal methods likewise list and revoke only the
presenting staff identity's sessions. Existing logout endpoints revoke server-side and clear their
respective cookie pairs. Credential replacement revokes both contexts; organization role and
membership changes revoke affected organization sessions in the same transaction as the change.
Unimplemented step-up and new public session-management endpoints remain denied.

The current central API hostname owns the browser cookies. Origin sealing stops a cookie from
being replayed from a different approved portal, but the browser still stores one host-only cookie
for the central API. Same-origin `/api/v1` routing on each tenant hostname is needed for browser
cookie isolation across simultaneous portals. Do not set a parent-domain privileged cookie.
The in-process throttle and account attempt stores are insufficient across multiple API replicas;
shared bounded abuse counters and a reviewed failure policy are required before production sign-in.
No database RLS policy exists and the Neon-managed owner is not an isolation boundary. Session
events currently have sanitized application logs, not an append-only atomic session audit table;
add that before treating remote session management as production complete.

## Global identity and credential foundation

User is global; OrganizationMembership and PlatformStaff remain separate assignments. Creating or
verifying an identity grants neither assignment. UserIdentityService and PasswordCredentialService
are internal services with no new HTTP routes. Every administrative operation requires an issued
platform principal and the live platform.identities.manage capability. Ordinary tenant contexts and
copied platform identities cannot invoke these operations. Profile selections exclude credentials.

Email identities use ASCII dot-atom local parts and NFC/IDNA domains converted to ASCII. Local parts
and domains are case-insensitive, with surrounding Unicode whitespace removed consistently. SMTPUTF8
local parts, quoted addresses, controls and ambiguous syntax are unsupported. Dots and plus-addressing
remain significant. PostgreSQL CITEXT uniqueness resolves concurrent duplicates; SQL rejects stored
Unicode/noncanonical syntax instead of silently rewriting existing identities. Display names are separate.

PENDING identities require mailbox proof before ACTIVE. Authorized review may suspend/reactivate an
eligible identity; DISABLED is terminal in this foundation. A shared account-state policy and live
credential checks apply to platform and owner login/session/MFA paths. Owner session creation rechecks
and locks account/credential eligibility after password work. Membership never overrides global state.
Platform MFA challenges retain the password proof's start time, so a concurrent password replacement
cannot be hidden by a later challenge insertion time.

Internal mailbox proofs expire after 15 minutes and store only purpose-separated token digests,
target email and identity version. Consumption is atomic and single-use. Identity changes invalidate
stale proofs. Email changes require proof for the new mailbox, revoke existing authentication state,
and retain the stable user ID. SQL clears stale verification and advances identity version on direct
email changes. Email delivery and public verification/account-management endpoints are not added.

New passwords require 15–1024 Unicode code points after NFC, with at most 4096 submitted UTF-8 bytes.
Passphrases, spaces and Unicode are supported; passwords are never trimmed or truncated. Controls and
unpaired surrogates are rejected for creation. There are no composition rules or periodic expiry.
Legacy login inputs may be shorter: creation policy must not silently lock out existing credentials.
Existing rows retain normalization=raw; new hashes explicitly use nfc. Unknown/unsafe stored hash
formats are denied through dummy verification, not reset or deleted. Legacy data has not been inspected live.

The shared hashing service retains Argon2id v19, 65536 KiB memory, 3 passes, parallelism 1 and random
salts. Two expensive jobs per provider are allowed concurrently; excess work returns a safe 503.
Missing/invalid credentials use bounded dummy verification. Verified upgrades preserve stronger stored
costs and recorded normalization, use optimistic versions, and retain passwordChangedAt. Rehashing
does not apply new-password policy to a verified legacy secret; replacement explicitly applies NFC
and the current creation policy. Benchmark on the intended production
host; parameter strength and concurrency have not been certified by local measurements.

Before production password creation, configure PASSWORD_BLOCKLIST_FILE and PASSWORD_BLOCKLIST_SHA256.
The file contains one lowercase SHA-256 index per line of an entire NFC/lowercase common or compromised
password, not credential hashes. Use an independently reviewed, current corpus that includes long
compromised passphrases. Production requires at least 10000 unique entries, an expected file checksum,
and a file no larger than 16 MiB; size alone does not prove corpus quality. No submitted password is
sent over a network. Missing/corrupt data fails creation closed with PASSWORD_POLICY_UNAVAILABLE;
existing login verification does not load the corpus. Development/offline tests have a limited common
password set, not a production breach corpus. Restart after changing the configured dataset.

Credential setup/replacement requires trusted administrative or existing enrollment/bootstrap authority.
Passwords are hashed before opening a transaction. User/credential versions prevent lost updates;
password replacement advances its timestamp and revokes owner sessions, platform sessions, pending
MFA and enrollment/mailbox proofs in the same transaction. Suspension, disablement and compromise use
the same invalidation hook. Future MFA reset must invoke it as part of its reviewed workflow; no new
reset endpoint is implemented. Audit failure rolls back the associated changes. Existing enrollment
and bootstrap now append real creation/verification events; rehash records an upgrade without revoking
sessions or pretending the password changed. Identity audit records contain action, actor IDs,
versions and request ID, never addresses, hashes, passwords or token material.

PASSWORD_POLICY_VIOLATION, PASSWORD_POLICY_UNAVAILABLE and ACCOUNT_ACTION_UNAVAILABLE use the existing
Problem Details catalog. Existing sign-in failures remain generic. Database roles/RLS remain the
production isolation blocker described above; these internal foundations do not authorize customer traffic.

Generate/build the updated sibling DB client before checking this API. Review and deploy the forward
identity_credential_foundation migration through the DB workflow before running changed authentication
paths. After committing/reviewing the DB changes, configure CI with that immutable commit:

```bash
gh variable set AKIBA_DB_SOURCE_REVISION --repo nexcoderw/akiba-api --body "$(git -C ../db rev-parse HEAD)"
```

This is a human-operated configuration command, not an agent action or publication step. The local
file dependency remains supported; no package version or lockfile was fabricated.
