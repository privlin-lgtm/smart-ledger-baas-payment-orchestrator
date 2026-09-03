import { supabase } from '../supabase.js';
import { getSystemAccountId } from './systemAccounts.js';
import { settleOpenRecord } from './ledgerSettlement.js';

export function generateSimulatedCardDetails() {
  const now = new Date();
  return {
    last4: String(Math.floor(1000 + Math.random() * 9000)),
    exp_month: now.getMonth() + 1,
    exp_year: now.getFullYear() + 3,
  };
}

interface CardRow {
  id: string;
  account_id: string;
  status: 'active' | 'frozen' | 'canceled';
  spend_limit_cents: number | null;
}

interface AuthorizationRow {
  id: string;
  idempotency_key: string;
  card_id: string;
  account_id: string;
  amount_cents: number;
  status: 'authorized' | 'captured' | 'reversed' | 'declined';
}

// Synchronous decision, like a real card network's sub-second authorization response —
// unlike a payout, there's no async callback: the card is either approved and held or
// declined right here.
export async function authorizeCard(
  cardId: string,
  input: { idempotencyKey: string; amountCents: number; merchant: string },
): Promise<{ authorization: unknown; status: number } | { error: string; status: number }> {
  const { data: existing, error: existingError } = await supabase
    .from('card_authorizations')
    .select('*')
    .eq('idempotency_key', input.idempotencyKey)
    .maybeSingle();
  if (existingError) return { error: existingError.message, status: 500 };
  if (existing) return { authorization: existing, status: 200 };

  const { data: card, error: cardError } = await supabase
    .from('cards')
    .select('id, account_id, status, spend_limit_cents')
    .eq('id', cardId)
    .maybeSingle<CardRow>();
  if (cardError) return { error: cardError.message, status: 500 };
  if (!card) return { error: 'card not found', status: 404 };

  async function decline(reason: string) {
    const { data, error } = await supabase
      .from('card_authorizations')
      .insert({
        idempotency_key: input.idempotencyKey,
        card_id: cardId,
        account_id: card!.account_id,
        merchant: input.merchant,
        amount_cents: input.amountCents,
        status: 'declined',
        decline_reason: reason,
        settled_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) return { error: error.message, status: 500 } as const;
    return { authorization: data, status: 201 } as const;
  }

  if (card.status !== 'active') return decline(`card_${card.status}`);
  if (card.spend_limit_cents !== null && input.amountCents > card.spend_limit_cents) {
    return decline('card_limit_exceeded');
  }

  // post_guarded_debit locks the account row and checks its balance inside the same
  // transaction as the hold, so two concurrent authorizations against the same account
  // can't both read the same starting balance and both post.
  const holdAccountId = getSystemAccountId('Card Holds');
  const { data: holdTransactionId, error: rpcError } = await supabase.rpc('post_guarded_debit', {
    p_idempotency_key: `${input.idempotencyKey}:hold`,
    p_description: `Card authorization at ${input.merchant}`,
    p_debit_account_id: card.account_id,
    p_credit_account_id: holdAccountId,
    p_amount_cents: input.amountCents,
  });
  if (rpcError) {
    if (rpcError.message.includes('insufficient_funds')) return decline('insufficient_funds');
    return { error: rpcError.message, status: 422 };
  }

  const { data: authorization, error: insertError } = await supabase
    .from('card_authorizations')
    .insert({
      idempotency_key: input.idempotencyKey,
      card_id: cardId,
      account_id: card.account_id,
      merchant: input.merchant,
      amount_cents: input.amountCents,
      hold_transaction_id: holdTransactionId,
    })
    .select()
    .single();
  if (insertError) return { error: insertError.message, status: 500 };

  return { authorization, status: 201 };
}

// Idempotent: an authorization no longer in 'authorized' is left untouched and its current
// row returned, so a duplicate capture call can't double-settle or re-release funds.
export async function captureAuthorization(
  authorizationId: string,
  captureAmountCents?: number,
): Promise<AuthorizationRow | null | { error: string }> {
  const { data: auth, error: fetchError } = await supabase
    .from('card_authorizations')
    .select('id, idempotency_key, card_id, account_id, amount_cents, status')
    .eq('id', authorizationId)
    .maybeSingle<AuthorizationRow>();
  if (fetchError) return { error: fetchError.message };
  if (!auth) return null;
  if (auth.status !== 'authorized') return auth;

  const captureAmount = captureAmountCents ?? auth.amount_cents;
  if (captureAmount > auth.amount_cents) {
    return { error: `captureAmountCents (${captureAmount}) cannot exceed the authorized amount (${auth.amount_cents})` };
  }

  const holdAccountId = getSystemAccountId('Card Holds');
  const releaseAmount = auth.amount_cents - captureAmount;

  return settleOpenRecord<AuthorizationRow>({
    table: 'card_authorizations',
    id: authorizationId,
    openStatus: 'authorized',
    idempotencyKey: `${auth.idempotency_key}:capture`,
    description: `Card authorization ${auth.id} captured`,
    entries: [
      { account_id: holdAccountId, amount_cents: -auth.amount_cents },
      { account_id: getSystemAccountId('Card Network Settlement'), amount_cents: captureAmount },
      ...(releaseAmount > 0 ? [{ account_id: auth.account_id, amount_cents: releaseAmount }] : []),
    ],
    updateFields: {
      status: 'captured',
      captured_amount_cents: captureAmount,
      settled_at: new Date().toISOString(),
    },
  });
}

// Idempotent for the same reason as captureAuthorization above.
export async function reverseAuthorization(authorizationId: string): Promise<AuthorizationRow | null | { error: string }> {
  const { data: auth, error: fetchError } = await supabase
    .from('card_authorizations')
    .select('id, idempotency_key, card_id, account_id, amount_cents, status')
    .eq('id', authorizationId)
    .maybeSingle<AuthorizationRow>();
  if (fetchError) return { error: fetchError.message };
  if (!auth) return null;
  if (auth.status !== 'authorized') return auth;

  const holdAccountId = getSystemAccountId('Card Holds');

  return settleOpenRecord<AuthorizationRow>({
    table: 'card_authorizations',
    id: authorizationId,
    openStatus: 'authorized',
    idempotencyKey: `${auth.idempotency_key}:reverse`,
    description: `Card authorization ${auth.id} reversed`,
    entries: [
      { account_id: holdAccountId, amount_cents: -auth.amount_cents },
      { account_id: auth.account_id, amount_cents: auth.amount_cents },
    ],
    updateFields: {
      status: 'reversed',
      settled_at: new Date().toISOString(),
    },
  });
}
