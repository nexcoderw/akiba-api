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

## Branch and pull request workflow

- Every new implementation, fix, redesign, refactor or documentation task uses a fresh,
  short-lived branch from an updated `main`, unless the user explicitly specifies another
  base. Name it `type/short-description`, such as `feat/organization-registration`,
  `fix/sidebar-highlight`, `style/organization-cards` or `docs/pr-handoff-rules`.
- Before editing, report the affected repository, inspected current branch, proposed task
  branch, PR base and focused scope. If the current branch is `main` or belongs to another
  task, identify the mismatch and provide safe human branch-preparation commands. Keep the
  task separate before committing; do not add unrelated work to an existing PR.
- The human creates and switches branches under the existing Git execution rules. This
  policy does not authorize agent-run Git writes. Inspect local changes and unpushed commits
  before suggesting a switch. Never assume `origin/main` is current without a fetch, or
  discard work to prepare a branch.
- Continue corrections and review feedback for an open PR on its existing branch. After
  that PR is merged or abandoned, start a fresh branch for the next task. Do not recycle a
  merged branch for a new PR.
- One PR delivers one coherent, reviewable outcome and may contain multiple files and
  commits. Preserve the one-file-per-commit handoff; it does not require one PR per file.
  Keep required styles, dependencies, tests and verified security repairs with their feature.
- A task spanning repositories needs a separate branch and PR in each repository. State
  the dependency and merge order, and link related PRs when their actual URLs are available.
  A dependent or stacked PR may use another base only when that relationship is explicit.

## Required PR information at every task handoff

In addition to the existing per-file commit commands, always provide:

1. Repository, inspected current branch, proposed task/head branch and target/base branch.
2. A copy/paste PR title and Markdown description matching the final change. Describe the
   problem, resulting behavior, relevant limitations and verification evidence.
3. Actual checks executed and their outcomes; clearly mark unexecuted checks as not run.
   Include exact human verification commands and relevant manual checks. Documentation-only
   work does not require invented application tests.
4. Related PRs, prerequisites and merge order, or explicitly state that there are none.
5. Readiness: `DRAFT` while required checks, review or dependencies are pending. Use
   `READY FOR REVIEW` only when the stated verification requirements are satisfied. Never infer that
   CI passed or a PR was approved from local source inspection.
6. Safe human commands for branch preparation, per-file commits and pushing the exact task
   branch, plus instructions for opening the PR against its stated base. Avoid placeholders
   in commands when the actual repository and branch are known.

Report PR metadata as proposed until the PR exists. Include a PR number, URL, check result
or merge result only when it has actually been observed. Do not generate command scripts.

Merge into `main` only after required checks pass, relevant manual verification is complete,
review feedback is resolved and repository approval requirements are satisfied. Check the
actual merge policy before recommending a merge method. Creating a PR is not authorization
to merge, publish, deploy or run a migration; preserve the existing human execution boundary.
