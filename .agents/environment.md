# Environment and secrets

Only development and production use live databases, matching akiba-db: the existing Neon branches,
default database and managed owner. Do not provision additional databases or PostgreSQL roles. Keep
only .env.local.example and .env.production.example as tracked templates. Do not add extra connection
profiles or database identity metadata. API runtime uses its selected pooled DATABASE_URL;
administrative connections and guarded live tests belong to akiba-db.

Development loads .env.local. Explicit NODE_ENV=production loads optional .env.production, with managed
injected values taking precedence. Offline NODE_ENV=test ignores environment files and database URLs;
tests replace the database module entirely. The real module must reject that test process before
creating an adapter or pool. NODE_ENV=test is not an additional database environment.

Validate PostgreSQL URLs, TLS, pool bounds, independent secrets, exact CORS origins, production HTTPS
and secure cookies before accepting traffic. Never include secrets or connection strings in errors,
logs, Git or npm configuration. No production fallback or automatic migration. Keep timestamps UTC
and apply Africa/Kigali only at explicit display/scheduling boundaries.
