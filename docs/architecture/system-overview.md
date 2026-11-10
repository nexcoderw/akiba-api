# System overview

Akiba is a shared NestJS 11 modular monolith using TypeScript ESM, Express 5 and the canonical
PostgreSQL/Prisma package. Public, platform and organization clients have separate trust boundaries.
Domain names such as `api.akiba.com`, `admin.akiba.com` and `musomesa.akiba.com` are design examples,
not deployment or DNS verification.

```text
TLS ingress -> server request ID/log observer -> Helmet -> bounded parsers -> exact CORS
 -> throttler -> origin/CSRF + live session + permission/membership guards
 -> validated controller -> scoped application service -> canonical database package
 -> safe DTO or catalog Problem Details
```

Existing authentication, MFA, session, organization and onboarding infrastructure is retained.
Inventory and full custom-role/recovery workflows are future work. See
[authentication foundation](authentication-foundation.md) and the
[security checklist](../security/security-checklist.md). Live tenant isolation is not production-ready.
