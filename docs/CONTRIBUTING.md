> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# Contributing

Branching, commit conventions, how to verify a change, and the PR checklist —
each derived from what this repo's history and tooling actually show, not
from a generic template. For local setup, see the
[Quick start](../README.md#quick-start) in the root README; for the guided
tour of a real request through the codebase, see
[ONBOARDING.md](./ONBOARDING.md).

## Branching

Every commit in `git log` sits directly on `master`. `git log --merges` finds
zero merge commits, and `git branch -a` lists only `master` (plus its
`origin/master` remote tracking branch) — no feature branch, past or present,
exists in this checkout. No branch-naming scheme (`feat/…`, `fix/…`, etc.) is
evidenced anywhere in the repository.

> ⚠️ TODO(owner): confirm whether feature branches + PR review are expected
> going forward, or whether committing directly to `master` remains the norm.
> No `.github/` directory, `CODEOWNERS` file, or PR template exists in this
> repo to infer a review process from.

## Commit messages

Git log gives a consistent, real pattern to follow:

```
<type>(<scope>): <short, specific summary>

- optional bulleted body, one point per line
- group related changes under a short ALL-CAPS label if the commit
  touches more than one area (e.g. "VIDEO:", "WATERMARK:")

Co-Authored-By: Claude <model name> <noreply@anthropic.com>
```

**Type** — one of `feat`, `fix`, `style`, `chore` (the only four seen in
`git log`).

**Scope** — the touched area, in parentheses, omitted when a change doesn't
fit one area. Scopes actually used: `(auth)`, `(admin)`, `(config)`, `(db)`,
`(enrich)`, `(pwa)`, `(search)`, `(stores)`, `(ui)`.

**Trailer** — 30 of the 31 commits on this branch end with
`Co-Authored-By: Claude <model name> <noreply@anthropic.com>` (the model name
varies by commit — `Claude Opus 4.8`, `Claude Fable 5`, etc.), crediting the
AI assistant that helped write the change. The one exception,
`2da9b17 chore: ignore .vercel`, is a one-line manual commit with no trailer
and no body. Follow the trailer convention when a commit was AI-assisted.

Real examples from the history:

```
feat(auth): login + roles + admin/tool split (Phase 5) with security hardening
Authentication, RBAC, and an admin-vs-tool separation (one app, host-routed):
- core/auth.ts: stateless signed-cookie sessions (HMAC via APP_SECRET), requireRole,
  reset tokens (raw emailed, sha256 stored, 30-min TTL)
- middleware.ts (Edge, no node:crypto): coarse presence gate + admin.<host> → /admin
...
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

```
fix(db): lazy neon() so the app builds without DATABASE_URL
The client was constructed at import time (`neon(process.env.DATABASE_URL || '')`),
which threw "No database connection string" during `next build` collect-page-data
whenever DATABASE_URL was absent — e.g. Vercel Preview deploys (GitHub auto-deploys),
causing build-failure emails. Now neon() is created lazily on the first query; imports
and builds never touch it, and callers already guard with dbConfigured().

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

## Running the checks

`package.json` defines exactly four scripts:

| Command | Runs | Purpose |
|---|---|---|
| `pnpm dev` | `next dev -p 3111` | dev server |
| `pnpm build` | `next build` | production build |
| `pnpm start` | `next start -p 3111` | run the production build |
| `pnpm typecheck` | `tsc --noEmit` | type-check the whole project |

There is no `lint` script and no `test` script — no ESLint config exists in
the repo, and no test framework is a dependency (see
[ONBOARDING.md § Testing workflow](./ONBOARDING.md#testing-workflow) for the
full gap). Before pushing a change, run:

```bash
pnpm typecheck
```

This is the only automated, repo-defined signal that a change is
structurally sound. `tsconfig.json` runs with `strict: true`, so this catches
real type errors, not just syntax mistakes.

## PR checklist

This repo has no CI — no `.github/workflows` directory exists, so nothing
below runs automatically on a pull request. Self-check it before requesting
review:

- [ ] `pnpm typecheck` passes with zero errors.

That's the one check this repo's tooling actually enforces today. There's no
lint step, no test suite, and no documented review/approval requirement to
add to this list without inventing one — see the TODO gaps above and in
[ONBOARDING.md](./ONBOARDING.md#testing-workflow) for what's missing.
