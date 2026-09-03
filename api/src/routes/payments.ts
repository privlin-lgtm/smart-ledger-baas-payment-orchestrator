import type { FastifyInstance } from 'fastify';
import { supabase } from '../supabase.js';
import { splitPaymentSchema } from '../schemas.js';

export async function paymentRoutes(app: FastifyInstance) {
  // Posts a single split payment as one balanced, atomic ledger transaction:
  // the source account is debited the full amount, and each split recipient
  // (e.g. supplier payout, platform fee) is credited their share.
  app.post('/api/payments/split', async (req, reply) => {
    const parsed = splitPaymentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { idempotencyKey, description, sourceAccountId, amountCents, splits } = parsed.data;

    const splitTotal = splits.reduce((sum, s) => sum + s.amountCents, 0);
    if (splitTotal !== amountCents) {
      return reply.code(400).send({
        error: `splits must sum to amountCents: expected ${amountCents}, got ${splitTotal}`,
      });
    }

    const entries = [
      { account_id: sourceAccountId, amount_cents: -amountCents },
      ...splits.map((s) => ({ account_id: s.accountId, amount_cents: s.amountCents })),
    ];

    const { data: transactionId, error } = await supabase.rpc('post_transaction', {
      p_idempotency_key: idempotencyKey,
      p_description: description ?? null,
      p_entries: entries,
    });

    if (error) return reply.code(422).send({ error: error.message });
    return reply.code(201).send({ transactionId });
  });
}
