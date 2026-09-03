-- Two more ledger-internal rails, following the same pattern as the payout engine's
-- Payouts Clearing / External Bank Rail accounts.
insert into accounts (name, type) values
  ('Card Holds', 'system'),
  ('Card Network Settlement', 'system');

-- A simulated virtual card issued against an account. Never stores a full PAN/CVV --
-- only a fake last4, matching how a real card-issuing API keeps full card data out of
-- your systems (PCI scope). spend_limit_cents caps a single authorization; unset means
-- the card is bounded only by the account's ledger balance.
create table cards (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  account_id uuid not null references accounts(id),
  status text not null default 'active' check (status in ('active', 'frozen', 'canceled')),
  network text not null default 'SANDBOX',
  last4 text not null,
  exp_month smallint not null check (exp_month between 1 and 12),
  exp_year smallint not null,
  spend_limit_cents bigint check (spend_limit_cents > 0),
  created_at timestamptz not null default now(),
  canceled_at timestamptz
);

create index cards_account_id_idx on cards(account_id);

-- A single card transaction's lifecycle: authorized (funds held against Card Holds) ->
-- captured (merchant is paid, funds move to Card Network Settlement) or reversed (hold
-- released back to the account) -- or declined outright, with no ledger impact at all.
-- Mirrors the payouts hold/settle pattern but the authorization decision is synchronous,
-- like a real card network's sub-second response, rather than an async callback.
create table card_authorizations (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  card_id uuid not null references cards(id),
  account_id uuid not null references accounts(id),
  merchant text not null,
  amount_cents bigint not null check (amount_cents > 0),
  captured_amount_cents bigint check (captured_amount_cents > 0),
  status text not null default 'authorized' check (status in ('authorized', 'captured', 'reversed', 'declined')),
  decline_reason text,
  hold_transaction_id uuid references transactions(id),
  settlement_transaction_id uuid references transactions(id),
  authorized_at timestamptz not null default now(),
  settled_at timestamptz
);

create index card_authorizations_card_id_idx on card_authorizations(card_id);
create index card_authorizations_status_idx on card_authorizations(status);

alter table cards enable row level security;
alter table card_authorizations enable row level security;
-- No policies, same as every other table: only the service-role API server can read/write.
