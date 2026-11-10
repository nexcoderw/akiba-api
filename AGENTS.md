# Mandatory Agent Instructions

Every agent working in this repository MUST read `.agents/README.md` and all rules it identifies as
relevant before editing. The rules are mandatory and do not depend on automatic discovery.

This repository owns HTTP APIs, application workflows, authentication, authorization, tenant
resolution, entitlements, integrations, and API tests. It never owns Prisma schema or migrations;
those belong exclusively to `@nexcoderw/akiba-db`.

Agents may inspect and edit files but must not run installation, formatting, linting, type-checking,
tests, builds, servers, databases, containers, deployment, or Git write commands. Follow
`.agents/agent-workflow.md` and the one-file-per-commit workflow in `.agents/git.md`.
