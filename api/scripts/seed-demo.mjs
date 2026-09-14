#!/usr/bin/env node
// Seeds a realistic demo scenario through the real running API (not direct DB writes) --
// two orders split between suppliers and the platform, a payout that settles, a payout
// that fails and reverses, and a card authorization that's captured plus one that's
// declined for exceeding its limit. Safe to re-run: every account/transaction created
// here is real, permanent ledger history (same as anything else in this app), so this
// adds a fresh, clearly-named batch each time rather than resetting anything.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {
    // .env is optional here if these are already set in the environment
  }
}
loadEnvFile(new URL('../.env', import.meta.url));

const API_URL = process.env.API_URL ?? 'http://localhost:8787';
const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error('API_KEY must be set (see api/.env)');

async function call(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'x-api-key': API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const key = (prefix) => `seed-${prefix}-${randomUUID()}`;

async function createAccount(name, type) {
  const account = await call('POST', '/api/accounts', { name, type });
  console.log(`  account: ${name} (${type}) -> ${account.id}`);
  return account;
}

async function main() {
  console.log('Seeding demo data against', API_URL);

  console.log('\naccounts:');
  const platform = await createAccount('Marketplace Platform', 'platform');
  const artisanCoffee = await createAccount('Artisan Coffee Roasters', 'supplier');
  const northwindFurniture = await createAccount('Northwind Furniture Co', 'supplier');
  const downtownCafe = await createAccount('Downtown Cafe Group', 'business');
  const riversideRetail = await createAccount('Riverside Retail', 'business');

  console.log('\nsplit payments:');
  await call('POST', '/api/payments/split', {
    idempotencyKey: key('order-4471'),
    description: 'Coffee bean order #4471',
    sourceAccountId: downtownCafe.id,
    amountCents: 50000,
    splits: [
      { accountId: artisanCoffee.id, amountCents: 45000, kind: 'payout' },
      { accountId: platform.id, amountCents: 5000, kind: 'fee' },
    ],
  });
  console.log('  Downtown Cafe Group paid $500.00 -> $450.00 Artisan Coffee Roasters + $50.00 platform fee');

  await call('POST', '/api/payments/split', {
    idempotencyKey: key('order-2209'),
    description: 'Office furniture order #2209',
    sourceAccountId: riversideRetail.id,
    amountCents: 120000,
    splits: [
      { accountId: northwindFurniture.id, amountCents: 108000, kind: 'payout' },
      { accountId: platform.id, amountCents: 12000, kind: 'fee' },
    ],
  });
  console.log('  Riverside Retail paid $1200.00 -> $1080.00 Northwind Furniture Co + $120.00 platform fee');

  console.log('\npayouts:');
  const settledPayout = await call('POST', '/api/payouts', {
    idempotencyKey: key('payout-settled'),
    accountId: artisanCoffee.id,
    amountCents: 30000,
    description: 'Weekly payout',
  });
  await call('POST', `/api/payouts/${settledPayout.id}/webhook`, { status: 'settled' });
  console.log('  Artisan Coffee Roasters: $300.00 payout -> settled');

  const failedPayout = await call('POST', '/api/payouts', {
    idempotencyKey: key('payout-failed'),
    accountId: northwindFurniture.id,
    amountCents: 20000,
    description: 'Weekly payout',
  });
  await call('POST', `/api/payouts/${failedPayout.id}/webhook`, {
    status: 'failed',
    failureReason: 'bank_account_closed',
  });
  console.log('  Northwind Furniture Co: $200.00 payout -> failed (bank_account_closed), hold released back');

  console.log('\ncard:');
  const card = await call('POST', '/api/cards', {
    idempotencyKey: key('card'),
    accountId: artisanCoffee.id,
    spendLimitCents: 20000,
  });
  console.log(`  issued •••• ${card.last4} for Artisan Coffee Roasters, $200.00 per-authorization limit`);

  const capturedAuth = await call('POST', `/api/cards/${card.id}/authorize`, {
    idempotencyKey: key('auth-captured'),
    amountCents: 7500,
    merchant: 'Office Depot',
  });
  await call('POST', `/api/cards/authorizations/${capturedAuth.id}/capture`, {});
  console.log('  $75.00 at Office Depot -> authorized and captured');

  const declinedAuth = await call('POST', `/api/cards/${card.id}/authorize`, {
    idempotencyKey: key('auth-declined'),
    amountCents: 25000,
    merchant: 'Delta Airlines',
  });
  console.log(`  $250.00 at Delta Airlines -> ${declinedAuth.status} (${declinedAuth.decline_reason})`);

  console.log('\nDone. Open the dashboard to see it: npm run dev:web');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
