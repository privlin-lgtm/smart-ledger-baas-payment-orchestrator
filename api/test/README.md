# API test suite

Integration tests that drive the real Fastify app via `app.inject()` (no port bound) against a
**real Supabase database**; there's no mock database. Each test creates its own fresh accounts
(`createAccount`/`fundAccount` in `helpers.ts`), so tests don't interfere with each other's
balances. But every account, transaction and ledger entry they create is real and, by the
ledger's own append-only design, **permanently unremovable**. That's why the tests run against a
throwaway **local Supabase stack**, never the demo or production project.

## Running locally with `supabase start`

You need Docker running and the [Supabase CLI](https://supabase.com/docs/guides/local-development)
(CI uses version 3.1.0). From the repo root:

```bash
# 1. Start a local stack. This applies every file in supabase/migrations/, in filename order.
#    The -x list skips services the API tests don't use (drop it to get Studio etc. too).
supabase start -x studio,imgproxy,mailpit,realtime,storage-api,edge-runtime,logflare,vector,supavisor,postgres-meta

# 2. Write api/.env.test from the local stack's URL and service-role key (gitignored).
supabase status -o env --agent no \
  --override-name api.url=SUPABASE_URL \
  --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY \
  | grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=' > api/.env.test
echo 'API_KEY="local-test-key"' >> api/.env.test

# 3. Run the suite.
npm test --workspace=api

# 4. Throw the stack away when you're done (or `supabase db reset` to wipe it and reapply
#    the migrations while keeping it running).
supabase stop --no-backup
```

The local keys are Supabase's fixed demo keys for `127.0.0.1`; they only work against your
own machine. CI (`.github/workflows/ci.yml`, job `test-api`) runs exactly these steps on every
push and pull request, with no secrets and no remote Supabase project.

## The guard

`test/env-guard.ts` runs before any test (from the `pretest` script and again from
`test/setup.ts`) and refuses to run when:

- `api/.env.test` is missing (outside CI);
- `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is empty;
- `SUPABASE_URL` contains a blocked project ref (`BLOCKED_SUPABASE_REFS`: the shared demo
  project `vhkkulfwrvxucmkjeemj` and the smart-ledger production project `xubkyfuknyfjecqzxdpx`);
- `SUPABASE_URL` is the same URL that `api/.env` gives the app.

Values in `api/.env.test` override anything already exported in your shell.

CI writes `api/.env.test` from its local stack, so the guard runs the same way there.
`SMART_LEDGER_TEST_ENV_FROM_PROCESS=true` still exists as an escape hatch for a test env that's
already exported in the process instead of in the file; the blocked-ref check applies either way.

## Commands

```bash
npm test --workspace=api                  # guard, then the suite
npm run test:check-env --workspace=api    # guard only, touches no database
```
