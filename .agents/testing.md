# Testing

Use unit tests for policies, integration tests for module/provider contracts, and e2e tests for HTTP
behavior. Cover DTO failures, authentication/authorization, safe absence/conflicts, rate limiting,
tenant/branch denial, revocation, dependency failures, headers and redaction where relevant.
Prefer offline adapter fakes; keep real guards active in HTTP tests. Never load production credentials.
Agents inspect and edit only; humans run commands and supply results.

Akiba has exactly two persistent Neon branches, development and production, using their existing
default database and managed owner. Do not create test databases or restricted custom roles. Any live
integration test must use the database repository's guarded development policy, synthetic fixtures,
scoped cleanup and an exclusive maintenance window. The legacy disposable bootstrap PostgreSQL
suite is incompatible with this policy and remains disabled pending redesign; do not enable it by
copying its old role/database assumptions.

Fixtures use fictional Kimihurura Supplies and Remera Trading organizations. Test missing, revoked and
cross-organization memberships without bypassing authorization. No order dependence, blanket
snapshots, production data, or passing-test claims without actual human output.
