# Platform Administrator Authentication

## Implemented flow

The browser at `admin.akiba.com` calls `api.akiba.com` directly with credentials enabled. Password login
normalizes email, performs an Argon2id comparison even for unknown identities, and requires an active,
email-verified user with an active `PlatformStaff` assignment. Successful password verification creates
only a five-minute MFA challenge; it never creates an administrative session.

Accepted password hashes are Argon2id v19 with 64–256 MiB memory, three to six iterations, and one to
four lanes. Password request bodies are capped at 1,024 characters. The inherited first-owner CLI is not an HTTP capability and remains blocked under the current DB policy.

MFA verification accepts either a confirmed TOTP factor or one unused recovery code. AES-256-GCM
authenticated decryption uses the credential's stored key identifier and version. TOTP acceptance,
recovery-code consumption, challenge consumption, and session creation occur within a serializable
transaction. Conditional updates prevent challenge, TOTP-step, and recovery-code replay.

The session endpoint checks absolute expiry, idle expiry, revocation, password-change time, active user
and staff status, and current role-permission relationships. A staff identity with no effective
permission is denied. The trusted system role `platform.owner` with `isSystem=true` grants the declared platform permission set; ordinary role names alone grant no authority. Logout digests the presented cookie,
revokes only the matching record, and clears the cookie with the original attributes.

## Browser and CSRF model

Production sessions use `__Host-akiba-platform-session` with `Secure`, `HttpOnly`,
`SameSite=Strict`, `Path=/`, and no `Domain`. Consequently, sibling subdomains cannot receive or set
that cookie. The API requires the exact configured `Origin` on login, MFA verification, and logout.
Login returns a random CSRF value and sets the same value in an API-host-only readable cookie; the
frontend sends the response value in `X-Platform-CSRF-Token` for MFA. Successful MFA rotates that value
for later logout. CORS is browser policy and never establishes authentication or authorization.

Authentication throttling keys the network source from the server socket and ignores forwarded IP
headers. A future trusted-proxy deployment needs an explicit reviewed proxy-hop configuration; until
then a reverse proxy may make the limiter deliberately more restrictive, never easier to bypass.

A future Next.js Backend-for-Frontend would terminate the browser session on the admin origin and use
a separate server-to-server credential to call the API. That architecture must not forward this API
cookie or silently broaden it to `.akiba.com`.

## Keys and rotation

`PLATFORM_AUTH_TOKEN_PEPPER` is a managed 32-byte base64 secret used for keyed database digests.
Changing it invalidates outstanding challenges, recovery-code lookup, and sessions, so rotation needs
an explicit sign-out plan.

`PLATFORM_TOTP_KEYRING` is a comma-separated `key-id=base64-key` list. Decryption selects the exact key
stored in `PlatformTotpCredential.encryptionKeyId`; old keys remain until credentials are re-encrypted
through a future controlled enrollment/rotation workflow. Version 1 binds ciphertext to staff ID, key
ID, and encryption version as AES-GCM additional authenticated data. Keys never belong in PostgreSQL,
Git, logs, or examples.

## Release and deployment prerequisites

The verified local DB package is 0.2.0 at `71096ae94640e8227623d700e5c2fcb9a12007fb`.
Registry artifact availability is unverified; build the reviewed sibling source and regenerate the API
lockfile through human npm execution. Database migrations remain exclusively in akiba-db and follow
its guarded development/production workflow; the API never migrates.

Keep bootstrap and invitation-delivery gates off. The retained bootstrap CLI's restricted-role/marker
assumptions conflict with the current managed-owner/two-branch policy. No additional persistent test
database or custom role is authorized. See the [blocked bootstrap runbook](../runbooks/platform-owner-bootstrap.md).

Supply independent production secrets, HTTPS origins and secure cookie settings through managed
configuration. Review the [security checklist](security-checklist.md): administrative database
privileges, tenant isolation, shared browser boundaries, distributed throttling, security audits and
human compilation/test evidence still block production approval. No deployment is certified here.
