import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let appPromise: Promise<FastifyInstance> | null = null;

// One app instance per test file (loadSystemAccounts() does a real network round trip;
// no need to pay that cost per test).
export function getApp(): Promise<FastifyInstance> {
  if (!appPromise) appPromise = buildApp();
  return appPromise;
}

export function authHeaders() {
  return { 'x-api-key': process.env.API_KEY ?? '', 'content-type': 'application/json' };
}

export function uniqueKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export async function createAccount(
  app: FastifyInstance,
  type: 'platform' | 'supplier' | 'business',
  name = uniqueKey(type),
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: authHeaders(),
    payload: { name, type },
  });
  if (res.statusCode !== 201) throw new Error(`createAccount failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

// There's no "mint money" endpoint by design -- fund a test account the same way the app
// itself allows a business account's balance to go negative: have a disposable funder
// business account pay into it via a split payment (which has no balance floor).
export async function fundAccount(app: FastifyInstance, accountId: string, amountCents: number) {
  const funder = await createAccount(app, 'business', uniqueKey('test-funder'));
  const res = await app.inject({
    method: 'POST',
    url: '/api/payments/split',
    headers: authHeaders(),
    payload: {
      idempotencyKey: uniqueKey('fund'),
      sourceAccountId: funder.id,
      amountCents,
      splits: [{ accountId, amountCents }],
    },
  });
  if (res.statusCode !== 201) throw new Error(`fundAccount failed: ${res.statusCode} ${res.body}`);
  return res.json();
}
