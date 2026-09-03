-- Maintain a running balance on accounts instead of aggregating ledger_entries on every
-- read (account_balances previously recomputed every account's balance from full history
-- on every call). Backfill from current history, then keep it in sync via trigger.
alter table accounts add column balance_cents bigint not null default 0;

update accounts a
set balance_cents = coalesce((select sum(le.amount_cents) from ledger_entries le where le.account_id = a.id), 0);

create or replace function bump_account_balance() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.accounts set balance_cents = balance_cents + new.amount_cents where id = new.account_id;
  return new;
end;
$$;

create trigger ledger_entries_bump_balance
  after insert on ledger_entries
  for each row execute function bump_account_balance();

-- account_balances now just reads the maintained column -- O(1) instead of a full
-- aggregation over ledger_entries every call.
drop view account_balances;

create view account_balances
with (security_invoker = true) as
select id as account_id, name, type, balance_cents
from accounts;

-- Closes a check-then-post race in payouts/card-authorizations, where the balance was
-- read in application code, checked, and only then posted -- two concurrent requests
-- could both read the same starting balance and both pass. `select ... for update` takes
-- a row lock on the debited account for the rest of this transaction, so a second
-- concurrent call for the *same* account blocks until the first commits (and its
-- cache-column update from the trigger above is visible), serializing the check-then-post
-- sequence per account. Concurrent calls against *different* accounts are unaffected.
create or replace function post_guarded_debit(
  p_idempotency_key text,
  p_description text,
  p_debit_account_id uuid,
  p_credit_account_id uuid,
  p_amount_cents bigint
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_balance bigint;
  v_existing_id uuid;
begin
  select id into v_existing_id from public.transactions where idempotency_key = p_idempotency_key;
  if v_existing_id is not null then
    return v_existing_id;
  end if;

  select balance_cents into v_balance from public.accounts where id = p_debit_account_id for update;
  if v_balance is null then
    raise exception 'account % not found', p_debit_account_id;
  end if;
  if v_balance < p_amount_cents then
    raise exception 'insufficient_funds: balance % is less than requested %', v_balance, p_amount_cents;
  end if;

  return public.post_transaction(
    p_idempotency_key,
    p_description,
    jsonb_build_array(
      jsonb_build_object('account_id', p_debit_account_id, 'amount_cents', -p_amount_cents),
      jsonb_build_object('account_id', p_credit_account_id, 'amount_cents', p_amount_cents)
    )
  );
end;
$$;
