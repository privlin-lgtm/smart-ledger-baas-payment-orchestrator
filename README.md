# Smart Ledger — BaaS Payment Orchestrator (MVP)

An embeddable sub-ledger for platforms that route split payments between
multiple parties (e.g. a marketplace paying a supplier and taking a platform
fee out of the same order). Built to demonstrate fintech-grade handling of
multi-party ledgers: atomic double-entry postings, idempotent writes, and an
immutable audit trail — the core plumbing a BaaS/card-issuance integration
would sit on top of.

## Architecture

- **Database — Supabase (Postgres)**
  - `accounts` — platform / supplier / business sub-accounts.
  - `transactions` — one row per logical financial event, keyed by a caller-supplied
    `idempotency_key` (unique).
  - `ledger_entries` — append-only, signed double-entry rows. A transaction's
    entries must sum to zero; both tables have `BEFORE UPDATE OR DELETE`
    triggers that reject mutation outright, so history can only be added to,
    never edited.
  - `post_transaction(...)` — a `SECURITY INVOKER`, search-path-pinned Postgres
    function that posts a transaction's entries atomically, validates the
    zero-sum invariant, and returns the existing transaction id on a replayed
    idempotency key instead of double-posting.
  - `account_balances` — a view deriving each account's balance as
    `sum(ledger_entries.amount_cents)`; balances are never stored directly.
  - `payouts` — the operational lifecycle of a simulated payout to an external
    bank rail (`processing` → `settled` | `failed`). Unlike the ledger this row
    is mutable (status advances as the simulated processor "calls back"), but
    every transition is backed by an immutable ledger transaction
    (`hold_transaction_id`, `settlement_transaction_id`), so the money movement
    itself stays fully auditable.
  - Two seeded `system`-type accounts — `Payouts Clearing` and `External Bank
    Rail` — are the ledger-internal rails a payout's funds move through; they're
    excluded from manual split payments.
  - RLS is enabled on every table with **no policies**, so `anon`/`authenticated`
    have zero access by default — all reads/writes are mediated by the API below.

- **API — `/api` (Fastify + TypeScript)**
  - Talks to Postgres with the Supabase **service role** key (server-side only).
  - Validates all input with `zod` before it reaches the database.
  - `POST /api/payments/split` builds a balanced entry set (source account
    debited the full amount, each split recipient credited their share) and
    posts it through `post_transaction`.
  - `POST /api/payouts` holds funds immediately (source account → Payouts
    Clearing, one balanced transaction) and schedules a simulated async
    settlement — a stand-in for calling a real BaaS provider's transfer API and
    waiting for their webhook.
  - `POST /api/payouts/:id/webhook` simulates that provider's callback (also
    used internally by the automatic timer): on `settled` it moves funds from
    Payouts Clearing to External Bank Rail; on `failed` it reverses the hold
    back to the source account. Idempotent — a payout no longer `processing` is
    left untouched, so a duplicate/late callback can't double-post.

- **Web — `/web` (React + Vite)**
  - Minimal console: create accounts, see live balances, post a split payment,
    request a payout and watch it settle or fail in real time (polls while any
    payout is `processing`), browse recent transactions.

## Setup

1. Install dependencies from the repo root:

   ```bash
   npm install
   ```

2. Fill in the API's service role key. Open [`api/.env`](api/.env) and set
   `SUPABASE_SERVICE_ROLE_KEY` (Supabase Dashboard → Project Settings → API →
   Service role secret). Everything else is already filled in for the
   `vhkkulfwrvxucmkjeemj` project. **Do not commit this file or share the key**
   — it bypasses Row Level Security.

3. Run both apps (two terminals):

   ```bash
   npm run dev:api   # http://localhost:8787
   npm run dev:web   # http://localhost:5173
   ```

## API reference

| Method | Path                      | Purpose                                        |
| ------ | ------------------------- | ----------------------------------------------- |
| GET    | `/api/accounts`            | List accounts with derived balances             |
| GET    | `/api/accounts/:id`        | One account + its 50 most recent entries        |
| POST   | `/api/accounts`            | Create an account (`name`, `type`)              |
| POST   | `/api/payments/split`      | Post a balanced split-payment transaction       |
| GET    | `/api/transactions`        | List recent transactions                        |
| GET    | `/api/transactions/:id`    | One transaction + its ledger entries            |
| POST   | `/api/payouts`             | Request a payout (holds funds, schedules settlement) |
| GET    | `/api/payouts`             | List recent payouts                             |
| GET    | `/api/payouts/:id`         | One payout                                      |
| POST   | `/api/payouts/:id/webhook` | Simulate the bank rail's settlement callback     |

`POST /api/payments/split` body:

```json
{
  "idempotencyKey": "unique-per-attempt",
  "description": "Order #1042",
  "sourceAccountId": "<business account uuid>",
  "amountCents": 10000,
  "splits": [
    { "accountId": "<supplier account uuid>", "amountCents": 9000, "kind": "payout" },
    { "accountId": "<platform account uuid>", "amountCents": 1000, "kind": "fee" }
  ]
}
```

Retrying the same `idempotencyKey` returns the original transaction instead of
posting a duplicate.

`POST /api/payouts` body:

```json
{
  "idempotencyKey": "unique-per-attempt",
  "accountId": "<supplier account uuid>",
  "amountCents": 4000,
  "description": "Weekly supplier payout"
}
```

Returns `400` if the account doesn't have enough balance. Settlement timing
and outcome are controlled by env vars (`PAYOUT_SETTLEMENT_DELAY_MS_MIN/MAX`,
`PAYOUT_FAILURE_RATE`, default 15%) — or force it immediately for a demo via
`POST /api/payouts/:id/webhook` with `{"status": "settled"}` or
`{"status": "failed", "failureReason": "..."}`.

## What's simulated vs. real

The ledger, balances, and audit trail are fully real (backed by actual
Postgres constraints and triggers, not just application code). The payout
engine models a real BaaS transfer API's async hold → webhook → settle/fail
lifecycle entirely within the ledger — no money actually leaves anywhere, and
there's no real bank or card-issuing integration behind it yet. That's the
next layer this would plug into.
