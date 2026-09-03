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
  - RLS is enabled on every table with **no policies**, so `anon`/`authenticated`
    have zero access by default — all reads/writes are mediated by the API below.

- **API — `/api` (Fastify + TypeScript)**
  - Talks to Postgres with the Supabase **service role** key (server-side only).
  - Validates all input with `zod` before it reaches the database.
  - `POST /api/payments/split` builds a balanced entry set (source account
    debited the full amount, each split recipient credited their share) and
    posts it through `post_transaction`.

- **Web — `/web` (React + Vite)**
  - Minimal console: create accounts, see live balances, post a split payment,
    browse recent transactions.

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

| Method | Path                  | Purpose                                   |
| ------ | --------------------- | ------------------------------------------ |
| GET    | `/api/accounts`        | List accounts with derived balances        |
| GET    | `/api/accounts/:id`    | One account + its 50 most recent entries   |
| POST   | `/api/accounts`        | Create an account (`name`, `type`)         |
| POST   | `/api/payments/split`  | Post a balanced split-payment transaction  |
| GET    | `/api/transactions`    | List recent transactions                   |
| GET    | `/api/transactions/:id` | One transaction + its ledger entries      |

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

## What's simulated vs. real

The ledger, balances, and audit trail are fully real (backed by actual
Postgres constraints and triggers, not just application code). Bank transfers
and card issuance are **not** wired up in this MVP — the split-payment engine
here is the layer a real banking/card-issuing API integration would plug into
next.
