# Database Package Consumption

Consume only public exports of `@nexcoderw/akiba-db`. The verified local source is version 0.2.0 at
`71096ae94640e8227623d700e5c2fcb9a12007fb`. Until registry availability is verified, `file:../db` is
the supported local mechanism; keep the sibling source at the reviewed revision and build it first.
CI checks out that immutable revision. Replace the local dependency with an exact published version
only after verifying its exports and compatibility. Humans generate the npm lockfile.

Register DatabaseModule once, enable shutdown hooks, preserve transaction scope and return explicit
API DTOs. Schema, generated client and migrations belong exclusively to akiba-db. No private paths,
API-owned Prisma generators, startup migrations, duplicate pools or fabricated exports.

TenantTransactionService validates identifier shape and sets transaction-local context; it does not
authorize users or constrain unrestricted queries. Every tenant query requires trusted membership and
an organization predicate. Owner credentials can bypass RLS, and the current package has no RLS
policies. Passing owner-based tests does not prove tenant isolation. Request necessary schema/security
changes separately in akiba-db and follow its guarded development/production deployment policy.
