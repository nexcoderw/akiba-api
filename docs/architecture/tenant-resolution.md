# Tenant Resolution

## Threat model

Calls reach `api.akiba.com`; the API hostname does not reveal the tenant portal. `Origin`, tenant portal
Host, CORS success, slug, route ID, and arbitrary tenant headers are client-controlled routing hints,
not authorization evidence. The same principal may belong to several organizations.

## Planned resolution contract

1. Authenticate the principal/session or trusted server-to-server caller.
2. Obtain the requested active organization from an explicit selection or validated route.
3. Load current organization membership through `@nexcoderw/akiba-db`.
4. Reject missing, revoked, or suspended membership and suspended organizations.
5. Establish immutable request tenant context with stable organization ID.
6. Evaluate branch/resource scope, permission, and entitlement per operation.
7. Execute all tenant persistence inside the database package’s tenant transaction primitive.

If a Next.js BFF forwards context, it must use authenticated, replay-resistant server credentials and
the end-user session must still be authorized. Platform support access uses a separate audited flow.

## Isolation coverage

Tenant IDs must appear in database queries, cache keys, queued jobs, files/exports, reports, search,
notifications, webhooks, and audit events. Tests create fictional Kimihurura Supplies and Remera Trading tenants and prove
cross-organization and cross-branch denial.
