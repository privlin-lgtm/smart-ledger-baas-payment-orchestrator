# API test suite

Integration tests that drive the real Fastify app via `app.inject()` (no port bound) against
the **real Supabase project** configured in `api/.env` — there's no mock database. Each test
creates its own fresh accounts (`createAccount`/`fundAccount` in `helpers.ts`), so tests don't
interfere with each other's *balances*, but every account, transaction, and ledger entry they
create is real and — by the ledger's own append-only design — **permanently unremovable**
(the same triggers that protect real financial history from being edited also block a test
cleanup script from deleting its own rows).

## Known tradeoff

Running these against the same project you use for demos means every test run leaves
`business-<uuid>` / `supplier-<uuid>` / `test-funder-<uuid>` accounts and their transactions
in that project's data permanently. This is cosmetic (clearly named, doesn't affect ledger
correctness) but will visibly clutter the Accounts table over time.

**The correct fix** is to run tests against a disposable Supabase branch instead of the main
project (`create_branch` via the Supabase MCP, or `supabase branches create` via the CLI) —
apply the migrations in `supabase/migrations/` to it and point `api/.env.test` at its
connection details. This wasn't set up automatically here because creating a branch is a
billed action on your Supabase account and needs your go-ahead first.

## Running

```bash
npm test --workspace=api
```

Requires `api/.env` to be populated (same as running the API itself).
