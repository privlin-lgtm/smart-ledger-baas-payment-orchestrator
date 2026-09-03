import type { FastifyInstance } from 'fastify';
import { supabase } from '../supabase.js';

export async function transactionRoutes(app: FastifyInstance) {
  app.get('/api/transactions', async (_req, reply) => {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, description, idempotency_key, reversal_of, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  app.get('/api/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const [{ data: transaction, error: txError }, { data: entries, error: entriesError }] = await Promise.all([
      supabase.from('transactions').select('*').eq('id', id).maybeSingle(),
      supabase
        .from('ledger_entries')
        .select('id, account_id, amount_cents, currency, created_at, accounts(name, type)')
        .eq('transaction_id', id),
    ]);

    if (txError) return reply.code(500).send({ error: txError.message });
    if (!transaction) return reply.code(404).send({ error: 'transaction not found' });
    if (entriesError) return reply.code(500).send({ error: entriesError.message });

    return { ...transaction, entries };
  });
}
