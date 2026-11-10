# Testing

Use offline unit tests for policies, integration tests for module/provider contracts and e2e tests for
HTTP behavior. Replace DatabaseIntegrationModule with the test-only OfflineDatabaseModule, then
provide narrow adapter fakes. Never instantiate a real adapter or pool in API tests, load environment
files or retain injected database credentials. Keep real HTTP authorization guards active.

Cover validation, authentication/authorization, resource scope, revocation, safe conflicts/absence,
rate limits, dependency failures, headers, correlation and redaction. Use fictional organization data
and explicit synthetic identities; no production data or credentials, order dependence or permissive
authorization replacements. Live PostgreSQL checks belong to akiba-db's guarded development workflow
and exclusive synthetic maintenance window, using its existing database and managed owner.

Agents inspect and edit only. Humans run commands and supply results; never claim a suite passed
without actual output. Do not create additional database resources or dedicated database profiles.
