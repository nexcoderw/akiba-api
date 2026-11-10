# Authentication foundation

Status: Step 1 source implementation; human installation, formatting, compilation, tests and live
security verification are pending. This is not a production authorization or tenant-isolation sign-off.
No new login, recovery, MFA-enrollment, invitation, custom-role or inventory endpoint was added.

## Inspected baseline

The cloned API already contained substantial reusable authentication and onboarding code. Retained
NestJS 11 modules include platform password/MFA verification and session management, platform
permission guards, organization registry/lifecycle and audits, invitation delivery/preview, owner
password sessions, enrollment/acceptance and organization portal identity. These are inherited
capabilities, not claims that Akiba-specific behavior or deployment has been verified.

Removed business modules: members, membership plans, payments, financial reports/PDF exports,
fitness dashboard analytics, reminders and their workers/configuration/tests. Shared identity,
authentication, session, audit and organization infrastructure remains. No database schema moved here.

## Verified database contract

Local `@nexcoderw/akiba-db` is version 0.2.0 at
`71096ae94640e8227623d700e5c2fcb9a12007fb`. Public exports include DatabaseModule, PrismaService,
TenantTransactionService, loadDatabaseConfig and generated Prisma models/enums/types. The API uses
`file:../db`; CI pins the source revision. Registry publication/artifact availability was not verified.
The human must regenerate the stale API lockfile after building that sibling package.

The inspected 23 models/14 enums cover global users/password credentials, platform staff and
permission/role assignments, organizations/memberships/roles, platform MFA challenges/sessions,
owner sessions/invitations/delivery/enrollment/acceptance and organization/platform/ownership audits.
There is no general organization permission catalog/role-permission mapping, Branch model, complete
password-reset lifecycle, or enabled RLS policy. Request needed schema changes separately in akiba-db.

DatabaseModule owns one connection pool and lifecycle. The API enables shutdown hooks; it never
runs migrations on startup. TenantTransactionService validates UUID shape and sets organization/branch
transaction-local settings that end on commit/rollback. It neither verifies membership nor restricts
an unrestricted query. No RLS, policy or FORCE RLS is enabled in the inspected migration set.

## Platform authentication boundary

`admin.akiba.com` is an illustrative platform frontend origin. Platform routes use their own cookie,
exact administrator Origin checks, CSRF on mutations, live database session/account/staff status and
MFA assurance. Current platform permissions are resolved again during authentication. Ordinary staff
need exact registered permission assignments.

The reviewed system-owner policy recognizes only a live `platform.owner` assignment with
`isSystem=true`; it supplies platform capabilities declared in the permission catalog. It does not
skip session expiry, MFA, CSRF, audit, tenant isolation or resource policy. Revoke the trusted role or
account/session to remove that owner's effective privileges; deleting individual permission links
alone is insufficient. Neither role labels from requests nor a platform email grant privileges.

## Organization authentication boundary

`musomesa.akiba.com` is an illustrative tenant portal. A hostname, Origin, slug, route/body organization
ID or X-Tenant-ID header is a routing hint, never authorization. Owner sessions identify a global user;
the service reloads active memberships, current organization status and assigned organization roles.
The origin-derived slug narrows the principal's accessible organizations. The portal route separately
checks the requested organization against those memberships and the organization-scoped owner role.
Pending organizations may read portal identity only; active business access needs ACTIVE status.

Platform roles cannot authorize tenant operations. Delegated organization administrators, ordinary
users, custom permissions and independent branch/resource scopes require a dedicated policy layer.
The old owner-only boundary must not become the universal organization authorization model.

## Global identity and tenant membership

A User and PasswordCredential describe one identity independent of organization. PlatformStaff and
OrganizationMembership represent separate authorizations. Membership status, organization status,
role assignment and resource scope must be verified live, including after privilege revocation.
Never infer membership from an email suffix, chosen subdomain, token claim alone or possession of an
object UUID. Prevent cross-organization role assignment through composite relationships and scoped
queries; database constraints complement application policy and are not a substitute for it.

## Sessions and revocation

Retained services store keyed digests of opaque random session credentials, not reusable plaintext
secrets. Platform and owner sessions are distinct, with absolute/idle expiry, revocation and live user
state. Password-change timestamps invalidate older sessions. Renewal uses bounded transaction logic;
retries must not replay uncertain credential/authorization writes. Cookie rebranding intentionally
invalidates old browser sessions. A valid platform session does not create an owner session.

Next work must verify concurrency, immediate role/membership revocation, stolen-session behavior,
revocation of all sessions after recovery, session rotation/fixation and assurance upgrades. Avoid
long-lived authorization snapshots. Session/dependency outages fail closed with safe 503 problems.

## Password lifecycle

Retained password services use Argon2id and bounded password DTOs, including a dummy password hash for
unknown identities. Development-only keys/hashes are not production credentials. Production secrets
must be independent, generated and managed outside source control. Never log passwords or send them
in URLs. Review actual hash parameters, normalization, breached-password policy, rehash upgrades and
resource limits before exposing authentication. No reset/change-password workflow was added here.

## MFA and recovery

Retained platform verification supports TOTP and one-time recovery codes, with expiring bounded
challenges, attempt limits, replay protection and encrypted TOTP material under a rotating keyring.
Email OTP is an opt-in inherited fallback, not proof of equivalent assurance. Owner assurance fields
exist, but they do not constitute a complete general organization MFA enrollment/recovery system.
Later steps must define enrollment confirmation, recent-authentication requirements, factor changes,
recovery-code custody/rotation, audit, privileged-account policy and forced revocation.

Password recovery is planned. Requests must give the same public response for existing, disabled and
unknown accounts, with bounded work and abuse controls. Recovery secrets must be random,
purpose-separated, short-lived, stored only as digests, single-use and atomically consumed. Bind the
flow to its intended identity, revoke sessions and notify through verified channels. Public invalid
and expired recovery requests must use one indistinguishable response. Reserved AUTH_* catalog codes
are contracts only; no recovery endpoint or token table was implemented in Step 1.

## Platform owner bootstrap

The inherited interactive CLI requires a restricted database role, exact target fingerprint/marker,
exclusive lock, first-owner checks and one-time MFA activation. It remains disabled and cannot run
under the current Neon managed-owner policy. Do not provision custom roles, additional persistent
databases or bypass its checks. A future operator workflow needs an explicit compatible security
design; see the [blocked bootstrap runbook](../runbooks/platform-owner-bootstrap.md).

## Organization owner invitations

Retained infrastructure binds invitations, organization relationships, tokens, enrollment and
acceptance records. Delivery uses separate HMAC and rotating authenticated-encryption keys,
transactional reservations, leases and conservative uncertainty handling. Public preview accepts a
body token and returns generic rejection. An invitation is not proof of an existing user's identity.
Acceptance must independently authenticate that user and atomically enforce eligibility/membership
rules. Do not put credentials in logs, query strings, analytics or support screens.

Delivery remains gated off. Its restricted worker-role/grant checks conflict with the managed-owner
policy and must be reconciled without weakening authorization. Verify sender ownership, acceptance
frontend, token handling, durable delivery/audit transitions and race behavior before release. No new
email, invitation or acceptance flow was built here; existing source was preserved for review.

## Custom roles and tenant data access

Planned organization roles need tenant-owned permission definitions, explicit role-permission
assignments and branch/resource scope. Those persistence mappings are missing from the current DB
package. Grant management requires authorization against escalation, actor's delegated grant scope,
audit and live revocation. Register permissions centrally and default deny; no arbitrary wildcards.

Before each tenant operation: authenticate; resolve the selected organization from validated routing;
load live active membership and organization state; evaluate permission/branch/resource and entitlement;
construct immutable trusted context; execute explicitly organization-scoped persistence inside the
canonical tenant transaction. Validate related object ownership even for valid UUIDs. Apply the same
context to jobs, cache keys, notifications, files, exports and audit records. A platform support bypass
requires a separate time-bounded justified audited design, not an ordinary tenant route.

The retained platform registry/dashboard deliberately make global control-plane queries behind
platform guards. Global user/session lookups are identity-bound. Removed commercial tenant modules
are not a basis for future unrestricted Prisma patterns. Current portal identity uses no arbitrary
organization query. No client-supplied tenant header establishes database transaction context.

## Cookies, CSRF and origins

Current cookies are host-only, SameSite=Strict, with HttpOnly session secrets; secure production
names use the __Host- prefix. CSRF cookies are intentionally readable and mutations require matching
header proof plus the appropriate Origin. Cookie Domain is never broadened to `.akiba.com`.
Global CORS now uses exact configured origins, credentials and exposed correlation/Retry-After
headers. A syntactically valid tenant subdomain no longer receives automatic CORS approval; list each
reviewed portal origin until a trusted tenant-origin resolver is implemented.

Browsers send host-only API cookies to the shared API host; separate cookie names do not alone isolate
all tenant frontend threats. Verify sibling-subdomain takeover, same-site requests, CSRF token delivery
and local-development port behavior. Decide whether a BFF per frontend or another reviewed session
boundary is required. Do not claim frontend CSRF integration is complete; no frontend was modified.

## Rate limits, audit and logging

A global Nest throttler and inherited per-auth account/IP limits bound common abuse. Storage is
process-local; production currently requires explicit single-instance acknowledgement. Distributed
stores/atomic counters, recovery/send limits, edge abuse controls and trusted client IP routing are
release requirements before scaling. TRUST_PROXY_CIDRS defaults empty and accepts only reviewed
explicit IP/CIDR ranges, never blanket proxy trust. TLS terminates at the reviewed ingress.

Organization lifecycle/ownership audits are retained. Complete security-event auditing, retention,
restricted access, attribution, MFA/recovery/role changes, and tamper resistance remain incomplete.
Never include credential material in audits. Managed-owner permissions currently allow audit mutation.
Request logs are separate from durable security audit evidence.

Correlation/logging precede parsing and guards. Logs contain server request ID, timestamp, method,
framework route template, status, public error code and duration. Unmatched paths become `unmatched`;
query strings, route values, payloads, cookies, raw exceptions and environment values are excluded.
The root logger projects reviewed structured fields only; startup failures expose a static event.
The exception filter makes no database queries and emits only bounded diagnostic codes for 5xx.

## Threat model and release boundary

| Threat                          | Existing/foundation control                                      | Evidence still required                                    |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Account enumeration             | Generic credential/MFA failures, approved catalog                | Timing, recovery and per-account abuse review              |
| Session theft/fixation          | Opaque digests, secure host-only cookies, live expiry/revocation | Rotation, browser/BFF and cross-subdomain tests            |
| CSRF or hostile portal          | Origin + CSRF, exact CORS, live membership                       | Tenant-origin registry, sibling compromise scenarios       |
| Cross-tenant object access      | Membership narrowing and scoped identity route                   | Complete permission/branch checks and live isolation proof |
| Privilege escalation            | Live roles and platform permission catalog                       | Organization mappings and delegated grant constraints      |
| Secret/error disclosure         | Problem Details, bounded validation, sanitized logs              | Human tests plus edge/proxy error behavior                 |
| Owner credential compromise     | Secrets outside repository                                       | Owner can bypass RLS/DDL/audits; unresolved DB boundary    |
| Brute force/resource exhaustion | Body limits, DTO limits, local throttling                        | Shared limits, ingress controls and reviewed auth costs    |
| Invitation replay/races         | Digests, transaction eligibility, leases/gates                   | Approved DB privileges, concurrent live tests and frontend |

Exactly two persistent Neon branches remain: development and production, using existing default
databases/managed owners. No live tests were run and no schema, role, database or migration was changed.
The absence of RLS plus administrative runtime credentials blocks multi-tenant production sign-off.
Step 2 may proceed as controlled development after human dependency/type/test verification, with these
security requirements tracked in the [checklist](../security/security-checklist.md).
