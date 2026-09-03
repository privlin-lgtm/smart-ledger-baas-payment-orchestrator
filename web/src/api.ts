const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
const API_KEY = import.meta.env.VITE_API_KEY ?? '';

export type AccountType = 'platform' | 'supplier' | 'business' | 'system';

export interface AccountBalance {
  account_id: string;
  name: string;
  type: AccountType;
  balance_cents: number;
}

export interface TransactionSummary {
  id: string;
  description: string | null;
  idempotency_key: string;
  reversal_of: string | null;
  created_at: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // A JSON content-type on a bodyless POST (freeze/unfreeze/cancel/reverse) makes
      // Fastify reject it as an empty JSON body, so only set this when there's a body.
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      'x-api-key': API_KEY,
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body ? JSON.stringify(body.error) : res.statusText;
    throw new Error(message);
  }
  return body as T;
}

export function listAccounts() {
  return request<AccountBalance[]>('/api/accounts');
}

export function createAccount(input: { name: string; type: AccountType }) {
  return request<AccountBalance>('/api/accounts', { method: 'POST', body: JSON.stringify(input) });
}

export function listTransactions() {
  return request<TransactionSummary[]>('/api/transactions');
}

export interface SplitInput {
  accountId: string;
  amountCents: number;
  kind?: string;
}

export function postSplitPayment(input: {
  idempotencyKey: string;
  description?: string;
  sourceAccountId: string;
  amountCents: number;
  splits: SplitInput[];
}) {
  return request<{ transactionId: string }>('/api/payments/split', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type PayoutStatus = 'processing' | 'settled' | 'failed';

export interface Payout {
  id: string;
  idempotency_key: string;
  account_id: string;
  amount_cents: number;
  status: PayoutStatus;
  external_reference: string | null;
  failure_reason: string | null;
  requested_at: string;
  settled_at: string | null;
  failed_at: string | null;
  accounts: { name: string; type: AccountType } | null;
}

export function listPayouts() {
  return request<Payout[]>('/api/payouts');
}

export function requestPayout(input: {
  idempotencyKey: string;
  accountId: string;
  amountCents: number;
  description?: string;
}) {
  return request<Payout>('/api/payouts', { method: 'POST', body: JSON.stringify(input) });
}

export function sendPayoutWebhook(payoutId: string, status: 'settled' | 'failed', failureReason?: string) {
  return request<Payout>(`/api/payouts/${payoutId}/webhook`, {
    method: 'POST',
    body: JSON.stringify({ status, failureReason }),
  });
}

export type CardStatus = 'active' | 'frozen' | 'canceled';

export interface Card {
  id: string;
  account_id: string;
  status: CardStatus;
  network: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  spend_limit_cents: number | null;
  created_at: string;
  canceled_at: string | null;
  accounts: { name: string; type: AccountType } | null;
}

export type AuthorizationStatus = 'authorized' | 'captured' | 'reversed' | 'declined';

export interface CardAuthorization {
  id: string;
  card_id: string;
  account_id: string;
  merchant: string;
  amount_cents: number;
  captured_amount_cents: number | null;
  status: AuthorizationStatus;
  decline_reason: string | null;
  authorized_at: string;
  settled_at: string | null;
  cards?: { last4: string; network: string } | null;
  accounts?: { name: string; type: AccountType } | null;
}

export function listCards() {
  return request<Card[]>('/api/cards');
}

export function issueCard(input: { idempotencyKey: string; accountId: string; spendLimitCents?: number }) {
  return request<Card>('/api/cards', { method: 'POST', body: JSON.stringify(input) });
}

export function setCardStatus(cardId: string, action: 'freeze' | 'unfreeze' | 'cancel') {
  return request<Card>(`/api/cards/${cardId}/${action}`, { method: 'POST' });
}

export function listCardAuthorizations() {
  return request<CardAuthorization[]>('/api/cards/authorizations');
}

export function authorizeCard(cardId: string, input: { idempotencyKey: string; amountCents: number; merchant: string }) {
  return request<CardAuthorization>(`/api/cards/${cardId}/authorize`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function captureAuthorization(authorizationId: string, captureAmountCents?: number) {
  return request<CardAuthorization>(`/api/cards/authorizations/${authorizationId}/capture`, {
    method: 'POST',
    body: JSON.stringify({ captureAmountCents }),
  });
}

export function reverseAuthorization(authorizationId: string) {
  return request<CardAuthorization>(`/api/cards/authorizations/${authorizationId}/reverse`, { method: 'POST' });
}
