# API Engineering Rules

## Purpose and precedence

These rules govern `@nexcoderw/akiba-api`. Human instructions come first, followed by `AGENTS.md` or
`CLAUDE.md`, this index, relevant topic rules, then tool defaults. Choose the safer tenant, security,
privacy, and financial interpretation if uncertainty remains.

## Mandatory standards

Read the applicable documents before work: `git.md`, `folder-structure.md`, `file-naming.md`,
`code-quality.md`, `typescript.md`, `comments.md`, `prettier.md`, `api-rules.md`, `swagger.md`,
`authentication.md`, `authorization.md`, `tenant-isolation.md`, `feature-flags.md`,
`subscriptions.md`, `database-consumption.md`, `security.md`, `validation.md`, `error-handling.md`,
`logging.md`, `environment.md`, `performance.md`, `testing.md`, `documentation.md`,
`background-jobs.md`, `notifications.md`, `integrations.md`, `privacy.md`, `dependencies.md`, and
`agent-workflow.md`.

## Forbidden practices

Do not add Prisma schemas/migrations, trust tenant headers, expose Prisma objects, weaken security for
development, or implement speculative product domains.

## Correct example

An organization endpoint authenticates the principal, resolves authorized organization context,
checks permission and entitlement, then invokes the published database package inside a tenant scope.

## Review checklist

- Relevant rules were read and the change remains API-owned.
- HTTP, tenant, permission, entitlement, privacy, and testing effects are explicit.
