# API test suite

Integration tests that drive the real Fastify app via `app.inject()` (no port bound) against a
**real Supabase project**; there's no mock database. Each test creates its own fresh accounts
(`createAccount`/`fundAccount` in `helpers.ts`), so tests don't interfere with each other's
balances. But every account, transaction and ledger entry they create is real and, by the
ledger's own append-only design, **permanently unremovable**. That's why the tests must never
run against the demo or production project.

## Test environment

The tests read **`api/.env.test`**, never `api/.env`.

1. Create a disposable Supabase project or branch (`supabase branches create`, or a separate
   free project) and apply the migrations in `supabase/migrations/` to it, in filename order.
2. Copy `api/.env.test.example` to `api/.env.test` and fill in that project's URL and
   service-role key, plus any `API_KEY` value. `api/.env.test` is gitignored.

## The guard

`test/env-guard.ts` runs before any test (from the `pretest` script and again from
`test/setup.ts`) and refuses to run when:

- `api/.env.test` is missing (outside CI);
- `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is empty;
- `SUPABASE_URL` contains a blocked project ref (`BLOCKED_SUPABASE_REFS`, currently the shared
  demo project `vhkkulfwrvxucmkjeemj`; add the production smart-ledger ref once it exists);
- `SUPABASE_URL` is the same URL that `api/.env` gives the app.

Values in `api/.env.test` override anything already exported in your shell.

In CI there's no file: the workflow passes the test project's details as secrets and sets
`SMART_LEDGER_TEST_ENV_FROM_PROCESS=true`. The blocked-ref check still applies there.

## Running

```bash
npm test --workspace=api                  # guard, then the suite
npm run test:check-env --workspace=api    # guard only, touches no database
```
