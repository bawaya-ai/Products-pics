> Generated: 2026-07-26 · Commit: 2f26e26 · Generator: make-docs

# Deployment

Scraper Pro deploys to Vercel as a single Next.js app (Node runtime functions).
A GitHub Actions workflow now type-checks every push/PR to `master`, but there
is still no CI/CD pipeline that builds, tests, lints, or deploys — deploys are
still triggered manually from a developer's machine with the Vercel CLI.

## CI: a type-check gate only

As of commit 2f26e26 this repo has its first CI workflow ever:
[`.github/workflows/typecheck.yml`](../.github/workflows/typecheck.yml). This
directly closes the "no CI exists" gap this doc used to document — but it is
narrow, and should not be read as "the repo now has CI/CD":

- **Triggers:** `push` to `[master]` and `pull_request` targeting `[master]`.
- **Steps:** `actions/checkout@v4` → `pnpm/action-setup@v4` (pinned to version
  `9`, matching `lockfileVersion: '9.0'` in `pnpm-lock.yaml`) →
  `actions/setup-node@v4` (`node-version: 22`, with pnpm caching) →
  `pnpm install --frozen-lockfile --ignore-scripts` → `pnpm typecheck`
  (i.e. `tsc --noEmit`).
- **Why `--ignore-scripts`:** type-checking only needs the `.d.ts` files
  already present in `node_modules`, not `sharp`/`onnxruntime-node`'s native
  postinstall builds — skipping those keeps the job fast and avoids
  native-build flakiness in CI.

**What this workflow is not:**

- Not a test suite — there is still no test runner or test script in
  `package.json`.
- Not a lint gate — there is still no ESLint config or
  `eslint`/`eslint-config-next` package.
- Not deploy automation — a green or red check on this workflow has no wired
  effect on Vercel. The deploy step is still the manual `vercel deploy --prod`
  (a.k.a. `vercel --prod`) documented below; CI passing or failing does not
  gate it in either direction.

Confirmed still absent, unchanged from before:

- No other `.yml`/`.yaml` file at the project level besides this workflow
  (the only other YAML files in the tree are
  `pnpm-workspace.yaml`/`pnpm-lock.yaml` and third-party files under
  `node_modules/`).
- No test script in `package.json` and no test runner dependency.
- No ESLint config and no `eslint`/`eslint-config-next` package.

There is still no automated gate between a commit and a production deploy —
`vercel --prod` is a manual command run from a developer's machine, and
nothing in this repo ties it to CI status. What changed: `tsc --noEmit` (via
`pnpm typecheck`) now runs automatically in GitHub Actions on every push/PR to
`master`, so a broken build is caught on the commit itself — but `next build`
is still never run in CI, and CI's pass/fail state has no wired effect on
whether someone goes on to run `vercel --prod`. Treat every `vercel --prod` as
a manual release: whoever runs it is still the release gate.

## Pipeline: commit → live

```mermaid
flowchart LR
    A[Developer commits\nto local git] --> B[Developer runs\npnpm typecheck / pnpm build\n(manual, not enforced)]
    A --> G[GitHub Actions: typecheck.yml\n(automatic on push/PR to master,\ntype-check only)]
    B --> C[Developer runs\nvercel --prod]
    C --> D[Vercel builds the project\n(next build, Node runtime)]
    D --> E[Functions deployed per\nvercel.json overrides]
    E --> F[Live at the production\ndomain(s)]
```

Pushing to `master` (or opening a PR against it) now also triggers G
automatically — but G is a side branch, not a gate: it doesn't feed back into
B or C, and nothing stops `vercel --prod` from running regardless of whether
G passed or failed. No step between A and C blocks the deploy; C remains a
fully manual action a developer runs from their machine. Steps D–F are Vercel
platform behavior triggered by the CLI, not by a repo-defined workflow.

## Manual deploy steps

Exact commands, from `README.md` "Deploy to Vercel" and confirmed against
`.vercel/project.json`:

```bash
vercel            # first run: links the local checkout to the Vercel project
vercel --prod     # promotes/builds to production
```

- `vercel` with no flags creates a preview deployment and, on first run, walks
  through linking the local directory to a Vercel project — this writes
  `.vercel/project.json`, which is gitignored (`.gitignore:3,9`), so every
  fresh clone must re-link once before it can deploy.
- `vercel --prod` builds and promotes straight to the production alias.
- The project is already linked for the existing checkout:
  ```json
  {"projectId":"prj_24GOrYSQcwYNW5f8UZaQ5zzrAvD3","orgId":"team_7Ah6es1qLuffzOGqXzAVTKKV","projectName":"scraper-pro"}
  ```
  (`.vercel/project.json`) — project `scraper-pro` under Vercel team
  `team_7Ah6es1qLuffzOGqXzAVTKKV`.
- Before deploying, set the environment variables from `.env.example` in
  **Vercel → Project → Settings → Environment Variables**. Every one of them is
  optional at the platform level — most can also be entered later through the
  in-app Admin "Integrations & Keys" panel, which persists to Postgres (env
  always wins over the DB/UI value when both are set). See
  [`docs/CONFIGURATION.md`](./CONFIGURATION.md) for the full variable reference.
- `APP_SECRET` is the one variable that is not optional in practice: `core/auth.ts:21-23`
  and `core/db.ts:24-26` both throw at request time if `NODE_ENV==='production'`
  and `APP_SECRET` is unset or under 16 characters — sessions and encrypted
  config storage both derive their key from it.

> ⚠️ TODO(owner): there is still no documented **pre-deploy** checklist in
> the repo. `.github/workflows/typecheck.yml` now runs `pnpm typecheck`
> automatically on every push/PR to `master`, so that part of this gap is
> narrower than it used to be — but it's a CI check on the commit, not a
> step wired into the deploy itself, and it never runs `pnpm build`. Confirm
> whether the team also runs `pnpm build` manually before every
> `vercel --prod`, and if so, write that down as a required step rather than
> leaving it tribal knowledge.

## Vercel function configuration (`vercel.json`)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "app/api/scrape/route.ts": { "maxDuration": 300, "memory": 3009 },
    "app/api/save/route.ts": { "maxDuration": 300 },
    "app/api/video-fetch/route.ts": { "maxDuration": 300 }
  }
}
```

| Route | `maxDuration` | `memory` | Why |
|---|---|---|---|
| `app/api/scrape/route.ts` | 300s | 3009 MB | Runs the full extraction → AI enrich → per-image processing pipeline; internal soft deadline `TIME_BUDGET_MS = 280_000` leaves 20s headroom under this hard kill (`app/api/scrape/route.ts:20,22`). The extra memory backs `sharp` image processing and the local ONNX cutout model. |
| `app/api/save/route.ts` | 300s | platform default | Long timeout exists so the destination store has time to download product video bytes server-side during import (`adapters/kissplay.ts:57-58`). |
| `app/api/video-fetch/route.ts` | 300s | platform default | Streaming video proxy fallback; upstream fetch itself uses a 280s abort timeout (`app/api/video-fetch/route.ts:14-15`). |
| All other API routes | platform default | platform default | No override in `vercel.json`. `app/api/test/route.ts` sets its own `export const maxDuration = 30` in-code (Next.js route-segment config) — separate mechanism from `vercel.json`, not visible there. |

`README.md` still says the deploy raises the function timeout to "60s" — that
line is stale. The real ceiling on the three heavy routes is 300s (5 minutes),
per `vercel.json` above.

### Build & runtime notes

- Framework: Next.js 15.3 (`package.json:15`), React 19, deployed as Node
  runtime serverless functions (every route sets `export const runtime = 'nodejs'`).
- `next.config.mjs:1-6` marks `sharp` and `onnxruntime-node` as
  `serverExternalPackages` so Vercel's bundler doesn't try to bundle these
  native/heavy packages into the function — they load from `node_modules` at
  runtime instead.
- Package manager is pnpm; `package.json` pins `sharp` and `onnxruntime-node`
  under `pnpm.onlyBuiltDependencies` so their native build scripts run.
- The only build/run entry points are the four scripts in `package.json`:
  `dev` (`next dev -p 3111`), `build` (`next build`), `start`
  (`next start -p 3111`), `typecheck` (`tsc --noEmit`). Vercel's platform
  build runs `next build`; nothing else in the repo customizes that step.
- The local ONNX background-removal model (`core/localbg.ts`) downloads its
  weights from GitHub Releases into `os.tmpdir()` on first use per warm
  lambda instance — the first `/api/scrape` call after a cold start (or after
  a fresh deploy rotates instances) will be slower while that download
  happens.

## Rollback procedure

> ⚠️ TODO(owner): **this repo has no rollback procedure.** There is no
> rollback script, no tagged-release convention, and no documented "how to
> revert a bad production deploy" process anywhere in the codebase or
> `README.md`. This is a gap, not an oversight to paper over — write one.

Until an in-repo procedure exists, the only available fallback is
platform-level, at Vercel itself:

- Every `vercel --prod` creates a new, independently addressable deployment;
  Vercel's dashboard keeps prior production deployments and lets you promote
  an older one back to the production alias (Vercel Project → Deployments →
  select a previous production deployment → redeploy/promote it). Exact menu
  wording may vary by Vercel dashboard version — this is documented Vercel
  platform behavior, not something specific to this repo.
- This only rolls back **application code**. It does **not** roll back
  anything in Postgres. Two consequences worth knowing before you rely on it:
  - There is no `CREATE TABLE`/migration file anywhere in the repo (confirmed
    by a whole-tree search) — the `app_config`/`stores`/`users` schema is not
    version-controlled at all, so there is nothing to "roll back" to for the
    DB side even in principle.
  - `app_config` holds encrypted provider keys and admin-edited settings that
    are read live by whichever code version is running — rolling back the
    app code does not undo any config value an admin saved through the UI
    after the bad deploy.
- Because `APP_SECRET` derives both the session-signing key and the
  `app_config`/`stores.token_enc` encryption key (`core/auth.ts:17-24`,
  `core/db.ts:20-28`), rolling back to an older deployment is safe only as
  long as `APP_SECRET` itself hasn't changed — a rotated `APP_SECRET` would
  invalidate live sessions and make previously-encrypted DB values
  undecryptable regardless of which app version is running.

## Post-deploy verification checklist

Grounded in what the code actually does — run these against the production
domain right after a deploy. Substitute your real deployed domain for
`$PROD_URL` (the app's own host allow-list for password-reset links names
`baw-ai.dev`, `admin.baw-ai.dev`, and `scraper-pro-zeta.vercel.app` as known
production hosts — `app/api/auth/request-reset/route.ts:29`).

1. **App loads at the production domain.**
   ```bash
   curl -sI https://$PROD_URL/login
   ```
   Expect `HTTP/2 200`. This exercises the Edge middleware's auth-page
   allowlist (`middleware.ts:13`) without needing a session.

2. **An unauthenticated request to an auth-gated API route returns 401.**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://$PROD_URL/api/status
   ```
   Expect `401`. `/api/status` is `requireRole`-gated with no cookie sent
   (`app/api/status/route.ts:13` → `core/auth.ts:61-66`) — a `200` here means
   auth is broken or `APP_SECRET` isn't behaving as expected.
   Repeat against `/api/config` (GET) and `/api/db-health` (GET) — both are
   also `requireRole`-gated and should also return `401` unauthenticated.

3. **An unauthenticated page request redirects to `/login`, not a blank page.**
   ```bash
   curl -sI https://$PROD_URL/
   ```
   Expect a `307`/`308` redirect to `/login?next=%2F`, per the middleware's
   coarse cookie-presence gate (`middleware.ts:19-23`).

4. **PWA files stay publicly reachable without a session** (they're excluded
   from the middleware's auth gate, `middleware.ts:30`):
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://$PROD_URL/manifest.webmanifest
   curl -s -o /dev/null -w '%{http_code}\n' https://$PROD_URL/sw.js
   ```
   Expect `200` for both.

5. **Login works end-to-end and issues a session cookie.**
   ```bash
   curl -si -X POST https://$PROD_URL/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"<known-admin-email>","password":"<password>"}'
   ```
   Expect `200 {"ok":true,"user":{...}}` with a `Set-Cookie: sp_session=...`
   header (`app/api/auth/login/route.ts:26-28`). A `401` here on known-good
   credentials most often means `APP_SECRET` differs from what signed the
   stored password hash's expectations, or the DB isn't reachable.

6. **Server-side provider keys are actually picked up.** Using the session
   cookie from step 5:
   ```bash
   curl -s -b 'sp_session=<token>' https://$PROD_URL/api/status
   ```
   Expect `200` with the `env` booleans matching what you set in Vercel →
   Environment Variables (`app/api/status/route.ts:16-29`) — e.g. `anthropic`
   should be `true` if `ANTHROPIC_API_KEY` was set.

7. **Database connectivity**, as an admin session:
   ```bash
   curl -s -b 'sp_session=<admin-token>' https://$PROD_URL/api/db-health
   ```
   Admin callers get the full `dbHealth()` object including a live table list
   (`app/api/db-health/route.ts:15` → `core/db.ts:186-192`) — confirms
   `DATABASE_URL` is set and Neon is reachable from the deployed function.

8. **Admin subdomain routing**, if `admin.<domain>` is configured:
   ```bash
   curl -sI https://admin.$PROD_URL/
   ```
   Expect a redirect to `/admin` (`middleware.ts:16-17`).

9. **A real scrape run completes.** Smoke-test `POST /api/scrape` with a
   known-good product URL from the logged-in UI (or `curl` with a session
   cookie and `Accept: application/x-ndjson`) and confirm the stream ends
   with a `{"type":"result", ...}` line rather than an `{"type":"error"}`
   line or a hang — this is the only way to confirm the 300s/3009MB function
   config in `vercel.json` was actually applied, since none of the above
   checks touch it.

None of this is scripted anywhere in the repo — there's no smoke-test file to
run. Do it by hand (or write one; the CI workflow above only type-checks, it
runs no tests and does no post-deploy verification).

## Related docs

- [`docs/CONFIGURATION.md`](./CONFIGURATION.md) — full environment variable reference.
- [`docs/RUNBOOK.md`](./RUNBOOK.md) — what to do when a specific failure mode shows up in production.
- [`docs/adr/0003-encrypted-config-in-postgres.md`](./adr/0003-encrypted-config-in-postgres.md) — why provider keys live in Postgres, not only env vars.
- [`docs/adr/0005-store-side-video-download.md`](./adr/0005-store-side-video-download.md) — why `app/api/save/route.ts` and `app/api/video-fetch/route.ts` need the long `maxDuration`.
- [`README.md`](../README.md) — quick start and local dev.
