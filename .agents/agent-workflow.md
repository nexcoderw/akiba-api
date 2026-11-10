# Agent Workflow

## Standards

Agents inspect first, edit only authorized scope, statically review files, record assumptions, and
provide exact human commands. Humans execute installation, formatting, linting, type-checking, tests,
builds, servers, database operations, Docker, CI/deployment, and all Git writes. Report every check as
not run until the human returns actual output. Follow `.agents/git.md` for one-file commits.

Every response completing file changes must include copy-paste commit commands and messages directly
in the conversation, with one file per commit. Never write commit plans to `.sh` files or other
artifacts. Include the commands even when human verification is pending, stating the actual check
status without claiming success.

## Forbidden practices

Agents MUST NOT run npm install/ci, formatting, linting, type-checking, tests, builds, Prisma/database
commands, servers, containers, deployments, CI, add/commit/push/tag or scripts wrapping them. Never edit
a lockfile manually or invent verification results.

## Example and checklist

After authoring an endpoint, provide ordered commands and wait for the human’s exact errors. Confirm
only inspection/file edits occurred, prerequisites are explicit, commands include working directory,
and per-file Git suggestions are included directly in the response.
