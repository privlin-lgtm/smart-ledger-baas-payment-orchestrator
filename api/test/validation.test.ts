import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, createAccount, getApp, uniqueKey } from './helpers.js';

describe('auth and input validation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getApp();
  });

  it('rejects any /api request with no x-api-key header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects any /api request with the wrong x-api-key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: { 'x-api-key': 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('allows /health with no key', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('answers a CORS preflight (OPTIONS) with no key required', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/accounts',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('rejects an amount over the configured ceiling', async () => {
    const source = await createAccount(app, 'business');
    const recipient = await createAccount(app, 'supplier');

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/split',
      headers: authHeaders(),
      payload: {
        idempotencyKey: uniqueKey('too-big'),
        sourceAccountId: source.id,
        amountCents: 100_000_000_00 + 1,
        splits: [{ accountId: recipient.id, amountCents: 100_000_000_00 + 1 }],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects zero and negative amounts', async () => {
    const source = await createAccount(app, 'business');
    const recipient = await createAccount(app, 'supplier');

    for (const amountCents of [0, -100]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/payments/split',
        headers: authHeaders(),
        payload: {
          idempotencyKey: uniqueKey('non-positive'),
          sourceAccountId: source.id,
          amountCents,
          splits: [{ accountId: recipient.id, amountCents }],
        },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects a request missing idempotencyKey', async () => {
    const source = await createAccount(app, 'business');
    const recipient = await createAccount(app, 'supplier');

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/split',
      headers: authHeaders(),
      payload: {
        sourceAccountId: source.id,
        amountCents: 100,
        splits: [{ accountId: recipient.id, amountCents: 100 }],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('404s a webhook for a nonexistent payout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/payouts/00000000-0000-0000-0000-000000000000/webhook',
      headers: authHeaders(),
      payload: { status: 'settled' },
    });
    expect(res.statusCode).toBe(404);
  });
});
