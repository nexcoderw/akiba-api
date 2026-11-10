# Security model

All requests, identifiers, origins, headers and provider responses are untrusted. Exact credentialed
CORS complements live session, membership, permission, origin and CSRF checks; it is not authorization.
Cookies are host-only with separate platform/owner names, HttpOnly session secrets and production
Secure enforcement. No broad cookie Domain is set. Cross-subdomain compromise and shared API cookie
behavior still require dedicated review before live tenant exposure.

The HTTP foundation uses Helmet, bounded body parsing, strict DTO validation, rate limits,
server-owned request IDs, catalog Problem Details and sanitized structured logs. Framework exception
messages and stacks are suppressed by the root logger. Filter diagnostics contain reviewed database
codes only, never SQL, credentials, URLs, payloads or exception messages. Logs are not durable audits.

Existing authentication uses Argon2id, purpose-separated token digests, encrypted TOTP material,
one-time challenges/recovery codes, session expiry/revocation and live account/role state. Public
credential failures remain generic. New recovery, delegated organization authorization and complete
security-event auditing are future work; retaining inherited source does not certify those flows.

The database package has composite relationship constraints but no RLS policies. Tenant transaction
settings are context only. Managed Neon owner privileges may bypass RLS and permit DDL/audit mutation.
No least-privilege runtime boundary or tamper-resistant audit guarantee is currently established.
The legacy bootstrap/worker role assumptions conflict with that policy and must not be bypassed.

Consult [authentication foundation](../architecture/authentication-foundation.md) for trust boundaries
and the [security checklist](security-checklist.md) for release blockers and required evidence.
