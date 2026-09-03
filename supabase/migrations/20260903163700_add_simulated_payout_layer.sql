-- 'system' accounts are internal ledger-only accounts (clearing/settlement rails) that
-- the payout engine posts against; they're never a source/recipient in a manual split payment.
alter table accounts drop constraint accounts_type_check;
alter table accounts add constraint accounts_type_check
  check (type in ('platform', 'supplier', 'business', 'system'));

-- Only one of each named system account should ever exist.
create unique index accounts_system_name_unique on accounts (name) where type = 'system';

insert into accounts (name, type) values
  ('Payouts Clearing', 'system'),
  ('External Bank Rail', 'system');

-- Payouts: the operational lifecycle of moving ledger funds out to a (simulated) external
-- bank rail. Unlike ledger_entries this is mutable -- status advances as the simulated
-- processor "calls back" -- but every transition is backed by an immutable ledger transaction
-- (hold_transaction_id, settlement_transaction_id), so the money movement itself is still
-- fully auditable even though this row's status field is not.
create table payouts (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  account_id uuid not null references accounts(id),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'processing' check (status in ('processing', 'settled', 'failed')),
  hold_transaction_id uuid not null references transactions(id),
  settlement_transaction_id uuid references transactions(id),
  external_reference text,
  failure_reason text,
  requested_at timestamptz not null default now(),
  settled_at timestamptz,
  failed_at timestamptz
);

create index payouts_account_id_idx on payouts(account_id);
create index payouts_status_idx on payouts(status);

alter table payouts enable row level security;
-- No policies, same as the other tables: only the service-role API server can read/write.
