import { supabase } from '../supabase.js';

interface LedgerEntry {
  account_id: string;
  amount_cents: number;
}

interface SettleOpenRecordInput {
  table: string;
  id: string;
  openStatus: string;
  idempotencyKey: string;
  description: string;
  entries: LedgerEntry[];
  updateFields: Record<string, unknown>;
}

// Shared by payout settlement and card-authorization capture/reverse: post a balanced
// ledger transaction, then apply it to the record only if it's still in `openStatus`.
// If a concurrent call already moved it out of `openStatus` first, this re-fetches the
// current row instead of returning the stale pre-check state, so callers never report a
// status the record no longer has (the ledger itself was already safe either way, since
// post_transaction's own idempotency key prevents a double-post).
export async function settleOpenRecord<T>(
  input: SettleOpenRecordInput,
): Promise<T | { error: string }> {
  const { data: transactionId, error: rpcError } = await supabase.rpc('post_transaction', {
    p_idempotency_key: input.idempotencyKey,
    p_description: input.description,
    p_entries: input.entries,
  });
  if (rpcError) return { error: rpcError.message };

  const { data: updated, error: updateError } = await supabase
    .from(input.table)
    .update({ ...input.updateFields, settlement_transaction_id: transactionId })
    .eq('id', input.id)
    .eq('status', input.openStatus)
    .select()
    .maybeSingle();
  if (updateError) return { error: updateError.message };
  if (updated) return updated as T;

  const { data: current, error: fetchError } = await supabase
    .from(input.table)
    .select('*')
    .eq('id', input.id)
    .single();
  if (fetchError) return { error: fetchError.message };
  return current as T;
}
