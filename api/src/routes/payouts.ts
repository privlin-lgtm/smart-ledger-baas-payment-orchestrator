import type { FastifyInstance } from 'fastify';
import { supabase } from '../supabase.js';
import { createPayoutSchema, payoutWebhookSchema } from '../schemas.js';
import { getSystemAccountId } from '../lib/systemAccounts.js';
import { applyPayoutOutcome, scheduleSimulatedSettlement } from '../lib/payoutSettlement.js';
import { parsePagination } from '../lib/pagination.js';

export async function payoutRoutes(app: FastifyInstance) {
  // Requests a payout: holds the funds immediately (source account -> Payouts Clearing,
  // one balanced ledger transaction) and schedules a simulated async bank-rail callback
  // that later settles or fails it, mirroring how a real BaaS transfer API behaves.
  app.post('/api/payouts', async (req, reply) => {
    const parsed = createPayoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { idempotencyKey, accountId, amountCents, description } = parsed.data;

    const { data: existing, error: existingError } = await supabase
      .from('payouts')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existingError) return reply.code(500).send({ error: existingError.message });
    if (existing) return reply.code(200).send(existing);

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('type')
      .eq('id', accountId)
      .maybeSingle();
    if (accountError) return reply.code(500).send({ error: accountError.message });
    if (!account) return reply.code(404).send({ error: 'account not found' });
    if (account.type === 'system') return reply.code(400).send({ error: 'cannot pay out from a system account' });

    // post_guarded_debit locks the account row and checks its balance inside the same
    // transaction as the hold, closing the check-then-post race a separate balance read
    // here would leave open under concurrent requests.
    const clearingAccountId = getSystemAccountId('Payouts Clearing');
    const { data: holdTransactionId, error: rpcError } = await supabase.rpc('post_guarded_debit', {
      p_idempotency_key: `${idempotencyKey}:hold`,
      p_description: description ?? `Payout hold for ${accountId}`,
      p_debit_account_id: accountId,
      p_credit_account_id: clearingAccountId,
      p_amount_cents: amountCents,
    });
    if (rpcError) {
      const status = rpcError.message.includes('insufficient_funds') ? 400 : 422;
      return reply.code(status).send({ error: rpcError.message });
    }

    const { data: payout, error: insertError } = await supabase
      .from('payouts')
      .insert({
        idempotency_key: idempotencyKey,
        account_id: accountId,
        amount_cents: amountCents,
        hold_transaction_id: holdTransactionId,
      })
      .select()
      .single();
    if (insertError) return reply.code(500).send({ error: insertError.message });

    scheduleSimulatedSettlement(payout.id);

    return reply.code(201).send(payout);
  });

  app.get('/api/payouts', async (req, reply) => {
    const pagination = parsePagination(req.query);
    if ('error' in pagination) return reply.code(400).send({ error: pagination.error });

    let query = supabase
      .from('payouts')
      .select('*, accounts(name, type)')
      .order('requested_at', { ascending: false })
      .limit(pagination.limit);
    if (pagination.before) query = query.lt('requested_at', pagination.before);

    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  app.get('/api/payouts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { data, error } = await supabase
      .from('payouts')
      .select('*, accounts(name, type)')
      .eq('id', id)
      .maybeSingle();
    if (error) return reply.code(500).send({ error: error.message });
    if (!data) return reply.code(404).send({ error: 'payout not found' });
    return data;
  });

  // Simulates the external processor's transfer webhook. In a real integration this is
  // where their signed callback would land; here it's exposed for demo control and for
  // testing that a duplicate/late callback can't double-post (applyPayoutOutcome no-ops
  // once the payout has left 'processing').
  app.post('/api/payouts/:id/webhook', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = payoutWebhookSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const updated = await applyPayoutOutcome(id, {
      status: parsed.data.status,
      failureReason: parsed.data.failureReason,
    });
    if (!updated) return reply.code(404).send({ error: 'payout not found' });
    return updated;
  });
}
