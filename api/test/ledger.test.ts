import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, createAccount, getApp, uniqueKey } from './helpers.js';

describe('core ledger invariants', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
  });

  it('rejects a split payment whose splits do not sum to the total', async () => {
    const source = await createAccount(app, 'business');
    const recipient = await createAccount(app, 'supplier');

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/split',
      headers: authHeaders(),
      payload: {
        idempotencyKey: uniqueKey('bad-split'),
        sourceAccountId: source.id,
        amountCents: 1000,
        splits: [{ accountId: recipient.id, amountCents: 900 }],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects an unbalanced transaction at the database layer, bypassing app validation entirely', async () => {
    const a = await createAccount(app, 'business');
    const b = await createAccount(app, 'supplier');

    const { supabase } = await import('../src/supabase.js');
    const { error } = await supabase.rpc('post_transaction', {
      p_idempotency_key: uniqueKey('db-level-unbalanced'),
      p_description: 'should be rejected by Postgres, not just the API',
      p_entries: [
        { account_id: a.id, amount_cents: -500 },
        { account_id: b.id, amount_cents: 400 },
      ],
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/sum to zero/);
  });

  it('is idempotent: replaying the same idempotency key returns the original transaction, not a duplicate', async () => {
    const source = await createAccount(app, 'business');
    const recipient = await createAccount(app, 'supplier');
    const idempotencyKey = uniqueKey('replay');
    const payload = {
      idempotencyKey,
      sourceAccountId: source.id,
      amountCents: 500,
      splits: [{ accountId: recipient.id, amountCents: 500 }],
    };

    const first = await app.inject({ method: 'POST', url: '/api/payments/split', headers: authHeaders(), payload });
    const second = await app.inject({ method: 'POST', url: '/api/payments/split', headers: authHeaders(), payload });

    expect(first.statusCode).toBe(201);
    expect(second.json().transactionId).toBe(first.json().transactionId);

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders() });
    const recipientBalance = accounts.json().find((a: { account_id: string }) => a.account_id === recipient.id);
    // Posted once, not twice: 500, not 1000.
    expect(recipientBalance.balance_cents).toBe(500);
  });

  it('append-only: rejects a direct UPDATE on ledger_entries even at the database layer', async () => {
    const { supabase } = await import('../src/supabase.js');
    const { data: rows } = await supabase.from('ledger_entries').select('id').limit(1);
    const { error } = await supabase
      .from('ledger_entries')
      .update({ amount_cents: 999999 })
      .eq('id', rows![0].id);

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/append-only/);
  });

  it('append-only: rejects a direct DELETE on transactions even at the database layer', async () => {
    const { supabase } = await import('../src/supabase.js');
    const { data: rows } = await supabase.from('transactions').select('id').limit(1);
    const { error } = await supabase.from('transactions').delete().eq('id', rows![0].id);

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/append-only/);
  });
});
