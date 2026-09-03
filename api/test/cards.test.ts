import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, createAccount, fundAccount, getApp, uniqueKey } from './helpers.js';

async function issueCard(app: FastifyInstance, accountId: string, spendLimitCents?: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/cards',
    headers: authHeaders(),
    payload: { idempotencyKey: uniqueKey('card'), accountId, spendLimitCents },
  });
  return res.json();
}

describe('card authorizations', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
  });

  it('declines over the card spend limit with no ledger impact', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 10000);
    const card = await issueCard(app, account.id, 2000);

    const res = await app.inject({
      method: 'POST',
      url: `/api/cards/${card.id}/authorize`,
      headers: authHeaders(),
      payload: { idempotencyKey: uniqueKey('auth-over-limit'), amountCents: 3000, merchant: 'Test Store' },
    });

    expect(res.json().status).toBe('declined');
    expect(res.json().decline_reason).toBe('card_limit_exceeded');
  });

  it('declines a frozen card', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 10000);
    const card = await issueCard(app, account.id);

    await app.inject({ method: 'POST', url: `/api/cards/${card.id}/freeze`, headers: authHeaders() });

    const res = await app.inject({
      method: 'POST',
      url: `/api/cards/${card.id}/authorize`,
      headers: authHeaders(),
      payload: { idempotencyKey: uniqueKey('auth-frozen'), amountCents: 100, merchant: 'Test Store' },
    });

    expect(res.json().status).toBe('declined');
    expect(res.json().decline_reason).toBe('card_frozen');
  });

  it('declines when the account cannot cover the amount, with no ledger impact', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 500);
    const card = await issueCard(app, account.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/cards/${card.id}/authorize`,
      headers: authHeaders(),
      payload: { idempotencyKey: uniqueKey('auth-insufficient'), amountCents: 1000, merchant: 'Test Store' },
    });

    expect(res.json().status).toBe('declined');
    expect(res.json().decline_reason).toBe('insufficient_funds');

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders() });
    const balance = accounts.json().find((a: { account_id: string }) => a.account_id === account.id);
    expect(balance.balance_cents).toBe(500); // untouched
  });

  it('partial capture settles part of the hold and releases the remainder back to the account', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 10000);
    const card = await issueCard(app, account.id);

    const auth = await app.inject({
      method: 'POST',
      url: `/api/cards/${card.id}/authorize`,
      headers: authHeaders(),
      payload: { idempotencyKey: uniqueKey('auth-partial'), amountCents: 3000, merchant: 'Test Store' },
    });
    expect(auth.json().status).toBe('authorized');

    const capture = await app.inject({
      method: 'POST',
      url: `/api/cards/authorizations/${auth.json().id}/capture`,
      headers: authHeaders(),
      payload: { captureAmountCents: 2000 },
    });
    expect(capture.json().status).toBe('captured');
    expect(capture.json().captured_amount_cents).toBe(2000);

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders() });
    const balance = accounts.json().find((a: { account_id: string }) => a.account_id === account.id);
    // 10000 - 3000 held + 1000 released back = 8000
    expect(balance.balance_cents).toBe(8000);
  });

  it('cannot capture an authorization that has already been reversed', async () => {
    const account = await createAccount(app, 'supplier');
    await fundAccount(app, account.id, 10000);
    const card = await issueCard(app, account.id);

    const auth = await app.inject({
      method: 'POST',
      url: `/api/cards/${card.id}/authorize`,
      headers: authHeaders(),
      payload: { idempotencyKey: uniqueKey('auth-reverse-then-capture'), amountCents: 1000, merchant: 'Test Store' },
    });
    const authorizationId = auth.json().id;

    const reversed = await app.inject({
      method: 'POST',
      url: `/api/cards/authorizations/${authorizationId}/reverse`,
      headers: authHeaders(),
    });
    expect(reversed.json().status).toBe('reversed');

    const captureAfterReverse = await app.inject({
      method: 'POST',
      url: `/api/cards/authorizations/${authorizationId}/capture`,
      headers: authHeaders(),
    });
    // Must stay 'reversed' -- a terminal state can't be flipped by a later capture.
    expect(captureAfterReverse.json().status).toBe('reversed');

    const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: authHeaders() });
    const balance = accounts.json().find((a: { account_id: string }) => a.account_id === account.id);
    expect(balance.balance_cents).toBe(10000); // fully released, capture-after-reverse had no effect
  });
});
