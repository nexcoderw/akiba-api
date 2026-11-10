# Git Workflow

## Purpose and scope

Keep Akiba API history reviewable while the developer retains every Git write.

## Mandatory requirements

Agents use read-only Git commands only. At task completion, provide one commit per changed file with
one exact `git add <file>` and `git commit` pair. Order dependencies before importers, tests, and linked
documentation. Commit all `.agents/` files as one uninterrupted group. Use
`type(scope): imperative summary`, lowercase, no period, at most 72 characters. Valid types are
`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, and `perf`.

## Forbidden practices

No agent-run add, commit, push, pull, merge, rebase, reset, restore, checkout, stash, tag, cherry-pick,
clean, branch writes, force pushes, secrets, generated output, or unmatched lockfiles.

## Correct example

```bash
git add src/config/environment.validation.ts
git commit -m "feat(config): validate api environment"
```

## Common mistakes

Bundling several files in one commit, staging a lockfile not produced by human npm execution, or
committing `.env` credentials.

## Review checklist

- Every file has one dependency-ordered message and command pair.
- Package and human-generated lockfile commits are consecutive.
- No secret, generated, ignored, or unrelated file is included.
