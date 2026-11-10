# Module boundaries

| Boundary                        | Retained responsibility                                                  |
| ------------------------------- | ------------------------------------------------------------------------ |
| Health                          | Process liveness, never database readiness                               |
| Platform authentication         | Password/MFA challenges, sessions, origin/CSRF and platform permissions  |
| Platform organizations          | Control-plane registry and audited lifecycle operations                  |
| Platform owner onboarding       | Invitation lifecycle and release-gated delivery/preview infrastructure   |
| Owner authentication/enrollment | Global identity sessions and invitation acceptance infrastructure        |
| Owner portal                    | Authorized organization identity; pending organizations remain read-only |
| Infrastructure                  | Canonical DatabaseModule and transactional email adapters                |
| Common/config/docs              | HTTP policy, safe errors/logging, environment validation and OpenAPI     |

The legacy bootstrap CLI is separate from HTTP and blocked pending a Neon-compatible design. No
inventory, membership-plan, member, payment, fitness report or reminder module remains. No new
product/authentication endpoint was added in Step 1.

Modules consume explicit public contracts, never another controller or private persistence helper.
Platform control-plane queries are deliberately global behind live MFA sessions and permissions.
Tenant operations require live membership, organization/branch scope and resource authorization;
platform roles grant no implicit organization access. Shared identity lookups are not tenant reads.

Database schema, migrations and client generation remain in akiba-db. See the
[authentication foundation](authentication-foundation.md) for existing versus planned capabilities.
