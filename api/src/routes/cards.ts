import type { FastifyInstance } from 'fastify';
import { supabase } from '../supabase.js';
import { authorizeCardSchema, captureAuthorizationSchema, issueCardSchema } from '../schemas.js';
import { authorizeCard, captureAuthorization, generateSimulatedCardDetails, reverseAuthorization } from '../lib/cardAuthorizations.js';
import { parsePagination } from '../lib/pagination.js';

export async function cardRoutes(app: FastifyInstance) {
  // Issues a simulated virtual card for an account. Only a fake last4 is ever generated
  // or returned — no full PAN/CVV, matching how a real card-issuing API keeps that out of
  // your systems entirely.
  app.post('/api/cards', async (req, reply) => {
    const parsed = issueCardSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { idempotencyKey, accountId, spendLimitCents } = parsed.data;

    const { data: existing, error: existingError } = await supabase
      .from('cards')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existingError) return reply.code(500).send({ error: existingError.message });
    if (existing) return reply.code(200).send(existing);

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, type')
      .eq('id', accountId)
      .maybeSingle();
    if (accountError) return reply.code(500).send({ error: accountError.message });
    if (!account) return reply.code(404).send({ error: 'account not found' });
    if (account.type === 'system') return reply.code(400).send({ error: 'cannot issue a card for a system account' });

    const { data: card, error: insertError } = await supabase
      .from('cards')
      .insert({
        idempotency_key: idempotencyKey,
        account_id: accountId,
        spend_limit_cents: spendLimitCents,
        ...generateSimulatedCardDetails(),
      })
      .select()
      .single();
    if (insertError) return reply.code(500).send({ error: insertError.message });

    return reply.code(201).send(card);
  });

  app.get('/api/cards', async (req, reply) => {
    const pagination = parsePagination(req.query);
    if ('error' in pagination) return reply.code(400).send({ error: pagination.error });

    let query = supabase
      .from('cards')
      .select('*, accounts(name, type)')
      .order('created_at', { ascending: false })
      .limit(pagination.limit);
    if (pagination.before) query = query.lt('created_at', pagination.before);

    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  app.get('/api/cards/authorizations', async (req, reply) => {
    const pagination = parsePagination(req.query);
    if ('error' in pagination) return reply.code(400).send({ error: pagination.error });

    let query = supabase
      .from('card_authorizations')
      .select('*, cards(last4, network), accounts(name, type)')
      .order('authorized_at', { ascending: false })
      .limit(pagination.limit);
    if (pagination.before) query = query.lt('authorized_at', pagination.before);

    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  app.get('/api/cards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [{ data: card, error: cardError }, { data: authorizations, error: authError }] = await Promise.all([
      supabase.from('cards').select('*, accounts(name, type)').eq('id', id).maybeSingle(),
      supabase.from('card_authorizations').select('*').eq('card_id', id).order('authorized_at', { ascending: false }),
    ]);
    if (cardError) return reply.code(500).send({ error: cardError.message });
    if (!card) return reply.code(404).send({ error: 'card not found' });
    if (authError) return reply.code(500).send({ error: authError.message });
    return { ...card, authorizations };
  });

  for (const [path, status] of [
    ['/api/cards/:id/freeze', 'frozen'],
    ['/api/cards/:id/unfreeze', 'active'],
    ['/api/cards/:id/cancel', 'canceled'],
  ] as const) {
    app.post(path, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { data: card, error: fetchError } = await supabase.from('cards').select('status').eq('id', id).maybeSingle();
      if (fetchError) return reply.code(500).send({ error: fetchError.message });
      if (!card) return reply.code(404).send({ error: 'card not found' });
      if (card.status === 'canceled') return reply.code(400).send({ error: 'card is canceled and cannot be changed' });

      const { data: updated, error: updateError } = await supabase
        .from('cards')
        .update({ status, ...(status === 'canceled' ? { canceled_at: new Date().toISOString() } : {}) })
        .eq('id', id)
        .select()
        .single();
      if (updateError) return reply.code(500).send({ error: updateError.message });
      return updated;
    });
  }

  // Synchronous authorization decision — approved (funds held) or declined outright.
  app.post('/api/cards/:id/authorize', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = authorizeCardSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const result = await authorizeCard(id, parsed.data);
    if ('error' in result) return reply.code(result.status).send({ error: result.error });
    return reply.code(result.status).send(result.authorization);
  });

  // Simulates the merchant capturing (finalizing) an authorization, optionally for less
  // than the held amount -- the difference is released back to the account.
  app.post('/api/cards/authorizations/:id/capture', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = captureAuthorizationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const result = await captureAuthorization(id, parsed.data.captureAmountCents);
    if (result === null) return reply.code(404).send({ error: 'authorization not found' });
    if ('error' in result) return reply.code(422).send({ error: result.error });
    return result;
  });

  // Simulates a void: the merchant or network releases the hold before capture.
  app.post('/api/cards/authorizations/:id/reverse', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await reverseAuthorization(id);
    if (result === null) return reply.code(404).send({ error: 'authorization not found' });
    if ('error' in result) return reply.code(422).send({ error: result.error });
    return result;
  });
}
