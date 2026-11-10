# ADR 0003: Consume an Exclusive Database Package

- Status: Accepted
- Date: 2026-10-12

Schema, migrations, client generation, and connection lifecycle belong solely to `akiba-db`. This API
consumes `@nexcoderw/akiba-db` through public exports, translates models to
DTOs, and never migrates on startup. `DatabaseIntegrationModule` registers the package once and makes
its exported services available without creating another client.

The database package exposes ESM-only output, so the API also emits ESM under its existing NodeNext
configuration. Relative TypeScript imports use `.js` runtime specifiers, and Jest maps those specifiers
back to TypeScript sources. The registry artifact must be verified to contain the required identity/security models before
installation; the source version alone is not proof of an immutable release.

## Step 1 local-source reconciliation

The verified source is 0.2.0 at `71096ae94640e8227623d700e5c2fcb9a12007fb`. Until a compatible
registry artifact is verified, use supported `file:../db` resolution with the reviewed sibling source;
CI pins that revision. Human npm execution must regenerate the API lockfile. Production packaging
requires an immutable verified artifact and completed compatibility checks.
