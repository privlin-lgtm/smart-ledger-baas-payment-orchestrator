-- Run the view with the querying role's privileges, not the creator's.
alter view account_balances set (security_invoker = true);

-- Pin search_path on SECURITY DEFINER-adjacent functions to block schema-hijacking.
create or replace function reject_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on % is not allowed; ledger history is append-only', tg_op, tg_table_name;
end;
$$;

create or replace function post_transaction(
  p_idempotency_key text,
  p_description text,
  p_entries jsonb,
  p_reversal_of uuid default null
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_transaction_id uuid;
  v_existing_id uuid;
  v_sum bigint;
begin
  select id into v_existing_id from public.transactions where idempotency_key = p_idempotency_key;
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

  insert into public.transactions (idempotency_key, description, reversal_of)
  values (p_idempotency_key, p_description, p_reversal_of)
  returning id into v_transaction_id;

  insert into public.ledger_entries (transaction_id, account_id, amount_cents, currency)
  select
    v_transaction_id,
    (entry->>'account_id')::uuid,
    (entry->>'amount_cents')::bigint,
    coalesce(entry->>'currency', 'USD')
  from jsonb_array_elements(p_entries) as entry;

  return v_transaction_id;
end;
$$;
