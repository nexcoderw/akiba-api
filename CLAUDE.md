# Mandatory Claude Code Instructions

Read `.agents/README.md` and its relevant linked rules before changing this repository. These rules are
mandatory. `akiba-api` is the shared multi-tenant NestJS application; database schema and migrations
remain exclusively in `akiba-db`.

Do not execute installation, generation, formatting, linting, type-checking, tests, builds, servers,
database operations, deployment, or Git writes. Give exact commands to the human. Follow the per-file
commit requirements in `.agents/git.md`.

Do not create a root docs directory or separate architecture/task reports. Only the existing
development and production databases are used; API tests remain offline with database module fakes.
