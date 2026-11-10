# Moving smart-ledger to its own Supabase project

smart-ledger's six tables (`accounts`, `transactions`, `ledger_entries`,
`payouts`, `cards`, `card_authorizations`) currently live in a shared Supabase
project that also holds another app's tables. This runbook moves them into a
dedicated project without corrupting balances.

Nothing here touches the old project except read-only exports. Leave the old
tables in place until the new project has been verified; dropping them is a
separate step (see "After the move").

## Before you start

- Create the new Supabase project (Dashboard → New project). Note its ref, URL,
  service role key and database connection string.
- Stop anything that writes to the old tables: the API (`npm run dev:api` or the
  hosted API), `npm run seed`, and the API test suite (`npm test --workspace=api`).
  All of them write to whatever `api/.env` points at. A write during the export
  leaves the copy inconsistent.
- Have `psql` available. Below, `$OLD_DB_URL` and `$NEW_DB_URL` are the two
  projects' Postgres connection strings (Dashboard → Connect). Don't paste them
  into files that get committed.

## 1. Apply the schema: migrations 1 to 4 only

Apply these files from [`supabase/migrations/`](../supabase/migrations) to the
**new** project, in this order:

1. `20260903153000_create_sub_ledger_schema.sql`
2. `20260903153100_harden_ledger_functions_and_view.sql`
3. `20260903163700_add_simulated_payout_layer.sql`
4. `20260903165900_add_simulated_card_issuance_layer.sql`

**Hold back** `20260903175800_add_cached_balance_and_guarded_debit.sql` until the
data is in (step 4). If you are not copying any data, apply all five now and
stop here.

Why hold the last one back:

- It creates the `ledger_entries_bump_balance` trigger, which adds every
  inserted ledger entry to `accounts.balance_cents`. If the trigger exists while
  you copy, every copied entry is added on top of the copied `balance_cents`,
  so every balance ends up doubled.
- Applied **after** the copy, it backfills `balance_cents` from the full ledger
  history once (`update accounts ... set balance_cents = sum(...)`) and only
  then creates the trigger. That is exactly what we want.

## 2. Remove the system accounts the migrations just seeded

Migrations 3 and 4 insert four system accounts with fresh UUIDs: `Payouts
Clearing`, `External Bank Rail`, `Card Holds` and `Card Network Settlement`. The
old project has the same four, under different UUIDs, and its ledger entries
point at those old UUIDs. Copying the old ones in would clash on the
`accounts_system_name_unique` index; keeping the new ones would orphan the old
history.

On the **new** project (nothing references these rows yet, and `accounts` has no
mutation guard):

```sql
delete from accounts where type = 'system';
-- expect: DELETE 4
```

## 3. Copy the data, parents first

Export from the old project and load into the new one, one table at a time, in
foreign-key order. `accounts` is copied **without** `balance_cents`, because the
new project doesn't have that column yet (step 4 adds and backfills it).

```bash
# accounts (no balance_cents)
psql "$OLD_DB_URL" -c "\copy (select id, name, type, created_at from public.accounts order by created_at) to 'accounts.csv' csv header"
psql "$NEW_DB_URL" -c "\copy public.accounts (id, name, type, created_at) from 'accounts.csv' csv header"

# transactions: reversal_of references transactions, so keep created_at order
psql "$OLD_DB_URL" -c "\copy (select * from public.transactions order by created_at) to 'transactions.csv' csv header"
psql "$NEW_DB_URL" -c "\copy public.transactions from 'transactions.csv' csv header"

# the rest, in this order (payouts and card_authorizations have no created_at)
for spec in ledger_entries:created_at cards:created_at payouts:requested_at card_authorizations:authorized_at; do
  t=${spec%%:*}; o=${spec#*:}
  psql "$OLD_DB_URL" -c "\copy (select * from public.$t order by $o) to '$t.csv' csv header"
  psql "$NEW_DB_URL" -c "\copy public.$t from '$t.csv' csv header"
done
```

Notes:

- `select *` column order matches between the two projects for every table
  except `accounts`, because both were built from the same migration files.
  If a `\copy` fails on a column mismatch, stop and compare
  `\d public.<table>` on both sides before retrying.
- Inserts are allowed by the append-only guards on `transactions` and
  `ledger_entries`; those triggers only block `UPDATE` and `DELETE`. If a copy
  fails halfway, don't try to delete the partial rows: drop and recreate the new
  project's schema (or the project) and start again from step 1.
- The CSV files contain real ledger data. Delete them when you're done.

## 4. Apply migration 5

Now apply `20260903175800_add_cached_balance_and_guarded_debit.sql` to the new
project. It adds `accounts.balance_cents`, backfills it from the copied ledger,
creates the `ledger_entries_bump_balance` trigger, rebuilds the
`account_balances` view and adds `post_guarded_debit`.

## 5. Verify before switching anything over

Run on **both** projects and compare:

```sql
select 'accounts' t, count(*) from accounts
union all select 'transactions', count(*) from transactions
union all select 'ledger_entries', count(*) from ledger_entries
union all select 'payouts', count(*) from payouts
union all select 'cards', count(*) from cards
union all select 'card_authorizations', count(*) from card_authorizations;
```

The counts must match exactly. Then, on the **new** project, each of these must
return zero rows:

```sql
-- cached balance equals ledger history for every account
select a.id, a.balance_cents, coalesce(l.s, 0) as ledger_sum
from accounts a
left join (select account_id, sum(amount_cents) s from ledger_entries group by account_id) l
  on l.account_id = a.id
where a.balance_cents <> coalesce(l.s, 0);

-- every transaction still sums to zero
select transaction_id, sum(amount_cents)
from ledger_entries group by transaction_id having sum(amount_cents) <> 0;

-- exactly one of each system account
select name, count(*) from accounts where type = 'system'
group by name having count(*) <> 1;
```

Also compare a few balances by hand between `account_balances` on the old
project and on the new one. Then check that there are exactly four system accounts:
`select count(*) from accounts where type = 'system';` should return `4`.

## 6. Switch over: Paul's checklist

The repo itself has no project ref left in it (`api/.env.example` uses a
`<project-ref>` placeholder). Everything that does carry the old project's
values lives outside the repo:

- [ ] **`api/.env`** on every machine: set `SUPABASE_URL` to the new project's
      URL and `SUPABASE_SERVICE_ROLE_KEY` to its service role key. `API_KEY`
      doesn't need to change, and `web/.env` doesn't reference Supabase.
- [ ] **The API host's environment variables** (wherever the API is deployed):
      the same `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Redeploy or
      restart so it picks them up.
- [x] **CI test database**: nothing to set up. The `test-api` CI job starts a
      local Supabase stack on the runner and needs no GitHub secrets or
      `RUN_INTEGRATION_TESTS` variable (see `api/test/README.md`). Don't add
      `SUPABASE_*` secrets for the production project.
- [ ] **Encrypted secrets backup**: make a new `yanshuf-secrets-YYYY-MM-DD.7z`
      in `G:\My Drive\Secrets Vault (ENCRYPTED)\` with the updated `api\.env`,
      refresh the copy in `C:\Users\privlin\secrets-backup\`, and check the
      SHA256 in `_RESTORE-README.txt` matches the new file.
- [ ] Start the API against the new project and hit `GET /health`, then load the
      dashboard and confirm balances match what you saw in step 5.

## After the move

- Keep the old tables, read-only by convention, until the new project has run
  cleanly for a while. Dropping them is a separate decision. The old project
  also holds another app's tables, so any cleanup there must name the six
  smart-ledger tables explicitly and touch nothing else.
- Don't rotate the old project's service role key as part of this move: the
  other app in that project uses it too.
