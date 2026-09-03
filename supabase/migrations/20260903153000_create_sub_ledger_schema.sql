-- Accounts: platform, supplier, and business sub-accounts within the embeddable sub-ledger
create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('platform', 'supplier', 'business')),
  created_at timestamptz not null default now()
);

-- Transactions: one row per logical financial event (e.g. a split payment or a reversal)
create table transactions (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  description text,
  reversal_of uuid references transactions(id),
  created_at timestamptz not null default now()
);

-- Ledger entries: append-only double-entry rows. Signed amount_cents; every transaction's
-- entries must sum to zero (enforced in post_transaction()). Never updated or deleted --
-- corrections are made by posting a new reversing transaction.
create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  account_id uuid not null references accounts(id),
  amount_cents bigint not null check (amount_cents <> 0),
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);

create index ledger_entries_transaction_id_idx on ledger_entries(transaction_id);
create index ledger_entries_account_id_idx on ledger_entries(account_id);

-- Current balance per account, derived from the ledger (never stored/mutated directly)
create view account_balances as
select
  a.id as account_id,
  a.name,
  a.type,
  coalesce(sum(le.amount_cents), 0) as balance_cents
from accounts a
left join ledger_entries le on le.account_id = a.id
group by a.id, a.name, a.type;

-- Immutability guards: transactions and ledger_entries are audit trail, append-only.
create or replace function reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed; ledger history is append-only', tg_op, tg_table_name;
end;
$$;

create trigger transactions_no_update_delete
  before update or delete on transactions
  for each row execute function reject_mutation();

create trigger ledger_entries_no_update_delete
  before update or delete on ledger_entries
  for each row execute function reject_mutation();

-- Post a balanced transaction atomically. Idempotent on idempotency_key: a replayed call
-- with the same key returns the original transaction id instead of posting twice.
create or replace function post_transaction(
  p_idempotency_key text,
  p_description text,
  p_entries jsonb,
  p_reversal_of uuid default null
) returns uuid
language plpgsql
as $$
declare
  v_transaction_id uuid;
  v_existing_id uuid;
  v_sum bigint;
begin
  select id into v_existing_id from transactions where idempotency_key = p_idempotency_key;
  if v_existing_id is not null then
    return v_existing_id;
  end if;

  if jsonb_array_length(p_entries) < 2 then
    raise exception 'a transaction requires at least two ledger entries';
  end if;

  select coalesce(sum((entry->>'amount_cents')::bigint), 0)
  into v_sum
  from jsonb_array_elements(p_entries) as entry;

  if v_sum <> 0 then
    raise exception 'ledger entries must sum to zero, got %', v_sum;
  end if;

  insert into transactions (idempotency_key, description, reversal_of)
  values (p_idempotency_key, p_description, p_reversal_of)
  returning id into v_transaction_id;

  insert into ledger_entries (transaction_id, account_id, amount_cents, currency)
  select
    v_transaction_id,
    (entry->>'account_id')::uuid,
    (entry->>'amount_cents')::bigint,
    coalesce(entry->>'currency', 'USD')
  from jsonb_array_elements(p_entries) as entry;

  return v_transaction_id;
end;
$$;

alter table accounts enable row level security;
alter table transactions enable row level security;
alter table ledger_entries enable row level security;
-- No policies are defined: anon/authenticated have zero access by default.
-- The API server talks to Postgres with the service_role key, which bypasses RLS,
-- so all reads/writes are mediated by the API layer and its own validation.
