import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, createAccount, fundAccount, getApp, uniqueKey } from './helpers.js';

describe('payouts', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
  });

  it('rejects a payout that exceeds the account balance, with no ledger impact', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 1000);

    const res = await app.inject({
      method: 'POST',
      url: '/api/payouts',
      headers: authHeaders(),
      payload: { idempotencyKey: uniqueKey('payout-too-big'), accountId: account.id, amountCents: 2000 },
    });

    expect(res.statusCode).toBe(400);

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders() });
    const balance = accounts.json().find((a: { account_id: string }) => a.account_id === account.id);
    expect(balance.balance_cents).toBe(1000); // untouched
  });

  it('closes the check-then-post race: two concurrent payouts against the same account cannot both succeed if together they exceed the balance', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 6000);

    // Genuinely concurrent: both requests are in flight before either resolves.
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/payouts',
        headers: authHeaders(),
        payload: { idempotencyKey: uniqueKey('race-a'), accountId: account.id, amountCents: 4000 },
      }),
      app.inject({
        method: 'POST',
        url: '/api/payouts',
        headers: authHeaders(),
        payload: { idempotencyKey: uniqueKey('race-b'), accountId: account.id, amountCents: 4000 },
      }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    // Exactly one must succeed (201) and the other must be rejected (400) -- both
    // succeeding would mean the account was allowed to go negative from a race.
    expect(statuses).toEqual([201, 400]);

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders() });
    const balance = accounts.json().find((x: { account_id: string }) => x.account_id === account.id);
    expect(balance.balance_cents).toBe(2000); // 6000 - one 4000 payout, never both
  });

  it('webhook is idempotent and cannot flip an already-terminal payout', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 1000);

    const create = await app.inject({
      method: 'POST',
      url: '/api/payouts',
      headers: authHeaders(),
      payload: { idempotencyKey: uniqueKey('webhook-payout'), accountId: account.id, amountCents: 500 },
    });
    const payoutId = create.json().id;

    const failed = await app.inject({
      method: 'POST',
      url: `/api/payouts/${payoutId}/webhook`,
      headers: authHeaders(),
      payload: { status: 'failed', failureReason: 'test' },
    });
    expect(failed.json().status).toBe('failed');

    // A later 'settled' callback must not override the terminal 'failed' state.
    const replay = await app.inject({
      method: 'POST',
      url: `/api/payouts/${payoutId}/webhook`,
      headers: authHeaders(),
      payload: { status: 'settled' },
    });
    expect(replay.json().status).toBe('failed');

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders() });
    const balance = accounts.json().find((x: { account_id: string }) => x.account_id === account.id);
    expect(balance.balance_cents).toBe(1000); // failed payout returned the hold in full
  });
});
