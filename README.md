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
That session can only reach invitation acceptance. Password-only provisional sessions now receive
AUTH_MFA_REQUIRED and cannot activate owner membership. Acceptance requires an AAL2 enrollment
session plus persisted invitation-bound stepUpVerifiedAt evidence newer than five minutes and not
in the future. Successful acceptance consumes the challenge and clears the provisional cookie;
it does not issue an organization session.
The Step 5 migration revokes all prior unbound owner sessions, so existing browsers must also
sign in again. Apply the reviewed DB migration and regenerate/build `api/db` before running this API.

Internal owner session methods can list at most 20 safe session summaries, revoke a selected or
other session within the caller's own membership, and atomically replace a full session token.
Rotation preserves the original absolute deadline and authentication evidence; the old token is
revoked in the same transaction. Platform internal methods likewise list and revoke only the
presenting staff identity's sessions. Existing logout endpoints revoke server-side and clear their
respective authentication cookies. Credential replacement revokes both contexts; organization role and
membership changes revoke affected organization sessions in the same transaction as the change.
Unimplemented step-up and new public session-management endpoints remain denied.

The current central API hostname owns the browser cookies. Origin sealing stops a cookie from
being replayed from a different approved portal, but the browser still stores one host-only cookie
for the central API. Same-origin `/api/v1` routing on each tenant hostname is needed for browser
cookie isolation across simultaneous portals. Do not set a parent-domain privileged cookie.
The in-process throttle and account attempt stores are insufficient across multiple API replicas;
shared bounded abuse counters and a reviewed failure policy are required before production sign-in.
No database RLS policy exists and the Neon-managed owner is not an isolation boundary. Platform
primary authentication, MFA outcomes and logout now use the existing append-only identity audit
table. Organization sessions and internal remote session management still need atomic security
auditing before being treated as production complete.

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
flows append real creation/verification events; bootstrap records pending identity creation only.
Rehash records an upgrade without revoking sessions or pretending the password changed.
Identity audit records contain action, actor IDs,
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

## Platform authentication

The initial owner remains pending because Step 6 has no approved mailbox-proof and credential/MFA
enrollment flow. These endpoints serve already active, independently verified and enrolled platform
staff; they cannot activate a pending owner. Step 8 management below preserves this bootstrap gate.
No public platform registration or password reset is added.

Deploy the reviewed DB migration `20261111180000_platform_authentication_audit` before these API
changes. It expands CHECK constraints on the existing identity audit table without changing the
Prisma schema or public package types. Audit failure rolls back challenge creation, MFA consumption,
session issuance or logout rather than returning a success response. Unknown credential failures
use sanitized operational logs and purpose-separated account digests rather than creating identities.
Existing identity lifecycle history is retained.

| Endpoint                                | Browser contract                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/platform/auth/login`      | Send email/password from the approved admin Origin. Receive `MFA_REQUIRED`, `VERIFY_MFA`, expiry, allowed methods and CSRF proof. The challenge is an HttpOnly cookie, never JSON. |
| `POST /api/v1/platform/auth/mfa/verify` | Send exactly one existing MFA method/proof and the CSRF header; the server resolves the account from the pending cookie. Never submit a challenge token or identity.               |
| `POST /api/v1/platform/auth/mfa/email`  | Existing opt-in fallback: pending cookie plus CSRF, no request body or recipient. Existing send cooldowns and quotas remain.                                                       |
| `GET /api/v1/platform/auth/me`          | Full session required. Returns safe identity, live roles/permissions, expiry and authenticated/MFA flags. `/session` remains an alias.                                             |
| `POST /api/v1/platform/auth/logout`     | Revoke the presented session and unused pending challenge, then expire session, challenge, step-up and CSRF cookies. Requires Origin and CSRF, including while MFA is pending.     |

Pending challenges expire within 60–300 seconds (default 300), allow at most the configured attempts
(default five), and contain only a keyed digest in PostgreSQL. The separate
`__Host-akiba-platform-challenge` cookie is signed for the configured administrative Origin,
HttpOnly, Secure in production, SameSite=Strict and host-only. Successful MFA consumes it atomically,
rejects reused TOTP steps, creates an independent opaque session token and rotates CSRF. Consumed,
expired and exhausted challenges cannot authenticate; terminal rejection clears the pending cookie.
Session and challenge tokens are never returned in JSON. Frontends must use credentialed requests
and keep only the returned CSRF proof, never authentication credentials, in JavaScript state.

Primary credentials, staff eligibility, identity version and declared platform permissions are
rechecked transactionally before issuing a challenge. Missing, suspended, disabled, unverified,
organization-only and unprivileged accounts receive the same generic credential failure. Existing
bounded Argon2id verification and malformed-hash dummy work are reused. Successful passwords also
consume account/network attempt quotas; there is no success-based counter reset. Capacity exhaustion
fails admission closed. Trusted client addresses use Express's explicit proxy allowlist.

MFA consumption, live eligibility reads, session issuance and audit persistence use a serializable
transaction. A serialization conflict returns a safe unavailable response rather than replaying an
uncertain operation. Session guards recheck account, credential, expiry and live roles on subsequent
requests. Logout uses conditional revocation, so only an actual change creates a revocation event.
Revocation that wins before MFA consumption prevents issuance. Logout cannot cancel a completion
that already committed or an operation already authorized; clients must serialize sign-in and logout.

Platform requests require the exact administrative Origin and an approved API/admin authority.
Forwarded authorities are used only from configured trusted proxy peers. Credentialed CORS remains
an explicit allowlist. A central API owns the host-only cookies: these guards enforce authentication
context, while physical browser cookie isolation on `admin.akiba.com` needs reviewed gateway routing.
No shared parent-domain cookie is used.

Errors retain `application/problem+json`, server request IDs and safe codes including
`PLATFORM_AUTHENTICATION_FAILED`, `PLATFORM_MFA_VERIFICATION_FAILED`,
`PLATFORM_SESSION_INVALID`, `ACCESS_DENIED`, `RATE_LIMITED` and `VALIDATION_FAILED`.
The catalog shares safe messages and statuses across related codes while preserving each accepted
code in the response. Login cannot reveal a missing MFA setup through a distinct public account-state
error.

Deployment remains restricted to a single API instance through
`PLATFORM_AUTH_SINGLE_INSTANCE=true`; a shared limiter and outage policy are required for replicas.
Persistent abuse counters across restarts, approved first-owner enrollment, live concurrency results,
and the managed-owner/RLS isolation design remain release prerequisites. Agent verification was
limited to source inspection and diffs; humans run npm and guarded development database checks.

## Platform MFA management and recovery

Step 8 reuses PlatformTotpCredential, PlatformMfaChallenge, PlatformRecoveryCode and the existing
opaque platform sessions. `PLATFORM_MFA_MANAGEMENT_ENABLED` defaults to false in both templates.
Keep it false until the forward database migration, generated package, keys, security sender and
notification worker have been reviewed and verified. Enabling it outside offline tests requires
explicit platform token and TOTP keys; TOTP keys cannot reuse any authentication pepper. Existing
encrypted factors retain their original key ID/version. Keep old decrypt keys during approved key
rotation; do not replace a key under an existing ID. Use independently managed 32-byte keys and
the existing keyring; this step adds no KMS integration or automatic key rotation.

Full platform access now requires a session explicitly issued through active TOTP. Recovery-code
login consumes one code and returns `mfa_recovery_required` with a maximum five-minute repair session.
It cannot reach `/me`, dashboard, organization administration or ordinary session-management methods.
Opt-in email OTP also returns restricted state and grants neither full platform access nor MFA
management; use TOTP or a saved recovery code to continue. Mailbox verification cannot replace the
privileged account's required factor. Legacy sessions are rejected, and the migration revokes them.
Frontends must inspect the returned status rather than treating every HTTP 200 as platform access.

All management endpoints require the exact admin Origin, approved Host, platform session cookie,
`x-platform-csrf-token` and existing real rate limiter, including the metadata GET. They never accept
a user, organization, role or challenge token in JSON. The separately signed, host-only HttpOnly
`__Host-akiba-platform-step-up` cookie is bound to the admin Origin; local HTTP uses
`akiba-platform-step-up`. Its signing purpose differs from the login cookie. Responses use no-store.

| Endpoint under `/api/v1/platform/auth`  | Required action and result                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /step-up/start`                   | Current password plus `operation`, and `factorId` for targeted actions; replaces prior management proofs. |
| `POST /step-up/verify`                  | Existing active TOTP; an unused recovery code may authorize repair only.                                  |
| `GET /mfa/factors`                      | Own factor ID, type, label, status and use/creation times only.                                           |
| `POST /mfa/totp/enroll`                 | Verified `totp_enroll` proof and no active TOTP; bounded label, one-time setup response.                  |
| `POST /mfa/totp/confirm`                | Enrollment cookie plus a six-digit code from the new authenticator.                                       |
| `POST /mfa/factors/:id/replace`         | Verified `totp_replace` proof for this factor; returns pending setup.                                     |
| `POST /mfa/factors/:id/replace/confirm` | Matching pending cookie and new TOTP code; commits replacement.                                           |
| `PATCH /mfa/factors/:id`                | Verified `factor_rename` proof; changes only the bounded label.                                           |
| `DELETE /mfa/factors/:id`               | Verified `totp_remove` proof; current one-factor policy denies final removal with 409.                    |
| `POST /mfa/recovery-codes/regenerate`   | Verified `recovery_regenerate` proof using password and TOTP.                                             |

Ordinary step-up requires current password followed by trusted-factor verification. Proofs bind the
staff identity, session, operation, target, identity/credential/MFA/factor versions, five-minute expiry
and five attempts. Each completed operation consumes its proof. Replacements leave the original
factor active until new TOTP confirmation commits. Starting again supersedes prior management state;
pending setup never authenticates. A recovery login has already consumed a trusted code; fresh
password verification may narrow that recent session directly to enrollment/replacement without
requiring a second recovery code. This permits recovery using the last saved code, but cannot rename,
remove or regenerate codes independently. Account suspension or credential/version changes invalidate
the flow. Loss of all factors and codes requires a future approved recovery process; bootstrap must
never be reopened as an account-recovery shortcut.

One canonical TOTP slot per staff is retained. New secrets have 160-bit entropy, issuer Akiba, SHA1,
six digits, a 30-second period and a one-step drift allowance. AES-256-GCM uses random 12-byte IVs,
authenticated staff/key/version context and a keyring outside PostgreSQL. Only the authorized setup
response contains the manual secret and provisioning URI; never navigate to, log, cache or persist
them in browser storage. Pending encrypted setup expires with its original proof. Confirmation stores
the accepted time step; conditional updates and serializable transactions reject concurrent replay.
The database denies deletion, disabling or unverifying the final active factor for non-revoked staff.

Confirmation and regeneration return ten independent 128-bit recovery codes once. PostgreSQL stores
only HMAC-SHA-256 verifiers under the authentication pepper with a distinct v2 domain, never the TOTP
key. Legacy v1 verifiers remain accepted only in the current generation until rotated. Each successful
use conditionally consumes one verifier, records an audit event and queues a safe security notification.
There is no plaintext retrieval endpoint. Factor changes advance MFA/recovery generations and revoke
all old platform sessions, proofs and unused codes atomically; regeneration does the same explicitly.
Recovery use revokes other sessions. Confirmation/rotation clears cookies and requires fresh TOTP
login; activation itself never issues a privileged session. Rename preserves replay state and assurance.

IdentitySecurityAuditEvent remains append-only and records step-up, enrollment, denied removal,
factor changes and recovery transitions without secrets. PlatformSecurityNotification is a separate
transactional outbox containing approved event, verified recipient and correlation ID. Audit/outbox
failure rolls back sensitive changes. The existing Resend adapter sends fixed templates with the
notification ID as its idempotency key and stores the validated provider message ID for reconciliation.
Queued means queued; provider acceptance means sent, not
confirmed mailbox delivery. After building, an operator can run one bounded batch:

```bash
NODE_ENV=development npm run worker:platform-security
```

The standalone worker loads the selected existing environment and sends at most 20 reserved rows.
Only one worker can reserve a queued row. Provider timeouts or recording failures become uncertain;
a crash can leave sending rows. Neither state is retried automatically. Operators must reconcile
provider state before any reviewed recovery, monitor queue age/failures and arrange scheduling. No
notification secrets or provider responses are printed. Verify sender ownership/DNS and delivery
before enabling management. Production scheduling, reconciliation, retention and delivery monitoring
remain deployment dependencies; the CLI does not create a scheduler or delivery-webhook workflow.

Management errors use the standard problem contract, including `AUTH_REAUTHENTICATION_REQUIRED`,
`AUTH_MFA_INVALID`, `AUTH_MFA_FACTOR_NOT_FOUND`, `AUTH_MFA_FACTOR_CHANGE_DENIED`, `ACCESS_DENIED`,
`VALIDATION_FAILED`, `RATE_LIMITED` and `SERVICE_UNAVAILABLE`. Expired or mismatched management proof
requires restarting reauthentication. Request IDs and safe messages remain centralized. Start/rotation
are limited to three per minute, verification/confirmation to five and other management routes to ten,
in addition to existing global controls. Persisted proof attempts supplement the single-instance
limiter; a distributed durable limiter and outage policy remain required before using replicas.

Future authenticators should implement typed enrollment/assertion verification and persisted replay
or signature-counter policy, with platform and organization authorization domains kept distinct. Safe
metadata already carries a factor type. Passkeys need reviewed registration/assertion challenge scope,
exact origin allowlists, a configured relying-party ID compatible with the admin host, user verification,
credential ownership and counter/backup handling. No passkey routes are implemented; TOTP is not
phishing-resistant. Multi-factor slots require a reviewed schema/policy expansion before allowing removal.

Human validation order: review DB status and SQL diff, deploy the reviewed migration in an exclusive
development window, validate/generate/build `api/db`, then format/lint/typecheck/test/build this API.
The local `file:../db` dependency remains unchanged; refresh installation only if its built package is
stale. Pin CI to the reviewed DB commit as above. Added unit, HTTP and guarded PostgreSQL cases have
not been executed by the agent. First-owner enrollment, managed-owner/BYPASSRLS isolation, operational
delivery, secret custody and live concurrency/rollback verification remain release gates. Step 8 is
partially complete until those checks and the restricted bootstrap enrollment are resolved; Step 9
development may proceed without activating customer or production authentication flows.

## Step 9 audit gate

The Step 9 audit found that the legacy acceptance service assigned active protected ownership from
AAL1 password authentication with no required owner MFA evidence. The service now denies that path
before any write and requires both AAL2 and a recent persisted enrollment step-up timestamp. Existing
unit success fixtures represent future trusted AAL2 evidence; they do not establish a working MFA
enrollment flow. The current enrollment service still issues only restricted AAL1 proof sessions and
does not write stepUpVerifiedAt. Therefore legitimate owner activation is blocked until an actual
organization-owner factor enrollment/verification flow supplies the required evidence. Never stamp
the timestamp on password success, promote assurance manually or reuse platform TOTP records.
Pending invitations remain pending on this rejection; no ownership, invitation consumption or full
organization session is created by acceptance.

Dependent Step 9 implementation stops at this critical gate. Existing organization registration,
lifecycle, invitation and delivery services are retained, but do not constitute the requested complete
approval/onboarding milestone. The schema still lacks a distinct reviewed organization approval
contract and activation readiness checks. Legacy activation endpoints must not be enabled for customer
onboarding on the assumption that this audit supplies those missing checks. Production remains blocked
by managed-owner/RLS limitations, owner MFA and approval prerequisites, unverified migrations,
notification operations and DNS/TLS/reverse-proxy deployment. No database migration, role, external
resource or production state was changed during this audit. New regression tests and all live database
guarantees remain unverified until human checks provide results.

## Step 10 audit gate

The Step 10 audit retains the Step 9 blocker: organization approval/readiness is not represented
separately, and no organization-owner MFA verifier exists. The legacy owner login still requests an
operational AAL1 membership session after password verification; this is not the required privileged
MFA login flow and must not be released as Step 10 authentication. Merely labelling a session AAL2,
copying platform TOTP credentials or bypassing the acceptance gate is not a remedy. Dependent new
login/MFA/profile endpoints remain unimplemented under the milestone's critical-blocker stop rule.
Step 11 account recovery is not ready to build on this incomplete assurance lifecycle.

An independent boundary correction makes the shared slug validator reject final LF, CR and Unicode
line separators. Its former JavaScript dollar anchor accepted a final line terminator, unlike the
registration DTO's absolute-end rule; a reserved name plus a terminator could pass the helper's
exact reserved-name comparison. Regression cases now cover ordinary and every reserved slug with
those suffixes. No live hostname exploit is claimed, and origin/Host checks remain mandatory.

Current source review does not verify remote freshness, live migrations, Neon RLS, DNS/TLS, proxy
routing or delivery operations. Agents have not run npm, Prisma, tests or builds. Production remains
blocked; neither existing application predicates nor owner-role integration tests establish an
independent database-enforced tenant boundary.

## Step 11 prerequisite repair

The Step 11 audit closes the legacy password-only operational owner-session path. OwnerSessionService
now rejects AAL1 membership-session issuance before generating a token or opening a transaction.
Existing operational sessions must carry AAL2 and a persisted MFA timestamp at or after primary
authentication and no later than the verification time; insufficient sessions are denied and marked
invalidated. This also prevents a low-assurance session from gaining operational access through a
later role assignment. Restricted AAL1 invitation-enrollment sessions remain separate and cannot
become active ownership through the acceptance gate. Failed session admission retains the generic
login failure and counts against the existing account/network attempts rather than clearing them.

The current legacy owner login supplies AAL1, so it now fails closed even for a correct password.
This is a deliberate security restriction until genuine organization MFA verification can issue the
appropriate assurance. The internal AAL2 argument is not itself MFA verification; no public route
may promote assurance or manufacture its timestamp. Existing synthetic AAL2 tests do not establish
a working organization MFA flow or production readiness.

Step 11 recovery endpoints remain unimplemented behind the unresolved Step 10 owner-MFA and
approval/readiness prerequisites. No forgot-password response, reset email, reset proof or password
change success is simulated. The existing administrative PasswordCredentialService remains separate
from self-service recovery: it uses the canonical password policy/Argon2id service, locks and versions
the global identity/credential, revokes platform and organization sessions and invalidates pending
proofs with its audit write in one transaction. It is not a public reset-token protocol. A future
password reset must preserve MFA and account/membership state and never issue a session.

No schema, migration, environment secret or delivery configuration changed in this repair. New
regressions exercise the real login/session service boundary, reject insufficient stored assurance
and preserve provisional enrollment. Tests, builds and live database checks have not been run by
the agent. Step 12 public authorization expansion remains gated by these unresolved prerequisites.

## Step 12 audit and authorization repair

Step 11 self-service password recovery remains absent: there are no forgot-password, reset-password
or authenticated change-password HTTP routes, reset-token records or reset-delivery workflow. The
existing administrative credential service is not evidence that those protocols are implemented.
Their request privacy, reset-proof concurrency and delivery requirements cannot be marked passed.

OrganizationAuthorizationService now enforces the same operational assurance floor as
OwnerSessionService during its transaction-level recheck. A matching AAL1 context/session is denied,
as is AAL2 with missing, future or pre-authentication MFA evidence. Rejection occurs before loading
membership grants. Previously this service removed only owner-only permissions from AAL1 grants,
leaving other role-management capabilities available to an internal caller with such a context.
Controller authentication does not replace this service-level check. Valid AAL2 authorization still
rechecks the selected membership, active roles and canonical permission mappings on each operation.

Existing Step 4 custom-role and assignment workflows remain internal. No public role-management
controller, new permission identifier, privilege metadata, database model or migration is added by
this repair. The eight existing organization capability keys remain separate from platform keys;
active role grants union only within the selected organization, and custom roles never inherit the
protected owner-only capability. Organization-specific purpose-bound step-up, complete owner MFA,
approval/readiness and Step 11 recovery remain prerequisites for the requested operational APIs.
Dependent Step 12 implementation is blocked under the brief's prerequisite-verification rule.

Regression cases cover AAL1, absent/future/old MFA evidence and valid AAL2 live grants. They are
authored but not executed. Managed-owner/BYPASSRLS isolation, production deployment/secret management,
distributed throttling, recovery governance and live migration/integration verification remain release
blockers. Final adversarial hardening can inspect these gaps, but Step 13 is not a production sign-off.
