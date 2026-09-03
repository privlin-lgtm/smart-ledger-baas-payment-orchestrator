import type { FastifyInstance } from 'fastify';
import { supabase } from '../supabase.js';
import { createAccountSchema } from '../schemas.js';

export async function accountRoutes(app: FastifyInstance) {
  app.get('/api/accounts', async (_req, reply) => {
    // Accounts are one per business partner, not one per event -- unlike
    // transactions/payouts/cards there's no natural cursor to page through here, just a
    // safety cap so this can't return an unbounded result set.
    const { data, error } = await supabase.from('account_balances').select('*').order('name').limit(500);
    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  app.get('/api/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [{ data: account, error: accountError }, { data: entries, error: entriesError }] = await Promise.all([
      supabase.from('account_balances').select('*').eq('account_id', id).maybeSingle(),
      supabase
        .from('ledger_entries')
        .select('id, transaction_id, amount_cents, currency, created_at, transactions(description, idempotency_key)')
        .eq('account_id', id)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    if (accountError) return reply.code(500).send({ error: accountError.message });
    if (!account) return reply.code(404).send({ error: 'account not found' });
    if (entriesError) return reply.code(500).send({ error: entriesError.message });

    return { ...account, recent_entries: entries };
  });

  app.post('/api/accounts', async (req, reply) => {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { data, error } = await supabase.from('accounts').insert(parsed.data).select().single();
    if (error) return reply.code(500).send({ error: error.message });
    return reply.code(201).send(data);
  });
}
