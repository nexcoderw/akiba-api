# API conventions

Use `/api/v1`, plural kebab-case resources, explicit response DTOs and UTC ISO 8601 instants.
GET never mutates business state. Collections require bounded cursor pagination and approved sort
fields. Validate path, query and body DTOs; do not implicitly coerce security-sensitive identifiers.
No API response exposes generated database models.

Errors use RFC 9457 `application/problem+json`; see the maintained
[frontend error contract](error-contract.md). Approved text, statuses, codes and bounded field issues
come from the catalog. No response path, timestamp, raw exception or rejected value is emitted.

Platform organization operations are privileged control-plane actions, not organization access.
Owner portal identity requires a live membership and owner role; pending status allows identity reads
only. Invitation delivery remains disabled until its database, worker, sender and frontend release
gates are reconciled. Existing acceptance code is retained, not newly delivered by Step 1.

Fictional fixtures use Kimihurura Supplies, Remera Trading and `owner@example.com`. No live tenant data,
email provider, production database or frontend repository is involved in the offline contract suite.
