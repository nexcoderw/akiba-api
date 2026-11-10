# Local development

Keep sibling repositories at `api/db` and `api/api`. The verified DB source is 0.2.0 at
`71096ae94640e8227623d700e5c2fcb9a12007fb`; the API consumes its public root using `file:../db`.
Humans prepare the DB dependency with `npm ci`, `npm run prisma:generate` and `npm run build` in db.
These commands generate/build artifacts; they do not apply migrations. Then in api regenerate the
stale lock with `npm install --package-lock-only` and install with `npm ci --include=dev`.
Do not use the old lock as evidence of canonical package compatibility.

Copy `.env.local.example` to ignored `.env.local` manually, using the approved existing development
Neon pooled URL and independent generated keys. Never copy production data/credentials or provision
extra databases/roles. The API does not load the DB repository's environment files. Production uses
injected secrets; no local dotenv files are loaded in test/production. Normal API runtime requires
only its pooled connection URL and never runs migrations.

Run formatting, lint, typecheck, offline tests and build in the README order. `NODE_ENV=test` uses an
unreachable localhost sentinel and mocked adapters; it is not an additional persistent database.
Never set `BOOTSTRAP_POSTGRES_TESTS=1` under the current policy. All authored commands/checks are
human-run. `npm run start:dev` starts the API only after human verification and configured development
secrets. Liveness under `/api/v1/health/live` does not prove database or tenant-isolation readiness.
