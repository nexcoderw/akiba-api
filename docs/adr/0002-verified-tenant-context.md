# ADR 0002: Resolve Verified Tenant Context Per Request

- Status: Accepted
- Date: 2026-10-12

Tenant portals call shared `api.akiba.com`, so Host, Origin, slug, CORS, and tenant headers cannot prove
access. The API will authenticate a principal, authorize active organization membership, evaluate
branch/resource scope, and pass stable context into database transactions. Missing context fails closed.
