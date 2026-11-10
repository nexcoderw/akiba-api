# Tenant Isolation

## Standards

Resolve active organization from authenticated, authorized context. A slug, Origin, Host, CORS result,
or `X-Tenant-ID` is routing input only. Verify membership for every active organization and scope data,
cache keys, jobs, files, reports, search, webhooks, notifications, and audit events by stable IDs.
Evaluate branch access independently and reject suspended organizations.

## Forbidden practices

No optional tenant filters, trust in Next.js forwarding without authentication, cache keys lacking
organization IDs, or unrestricted cross-tenant helpers.

## Example and checklist

`kimihurura.akiba.com` may select Kimihurura Supplies, but only the principal's verified membership grants access. Test tenant
A against tenant B across every storage and asynchronous boundary.
