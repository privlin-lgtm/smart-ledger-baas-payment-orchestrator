import { z } from 'zod';

// A generous but real ceiling ($100M) -- prevents absurd/overflow-adjacent values from
// ever reaching the ledger without constraining any plausible real transaction.
const MAX_AMOUNT_CENTS = 100_000_000_00;
const amountCentsSchema = z.number().int().positive().max(MAX_AMOUNT_CENTS);

export const createAccountSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['platform', 'supplier', 'business']),
});

export const splitSchema = z.object({
  accountId: z.string().uuid(),
  amountCents: amountCentsSchema,
  kind: z.string().min(1).max(50).optional(),
});

export const splitPaymentSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  sourceAccountId: z.string().uuid(),
  amountCents: amountCentsSchema,
  splits: z.array(splitSchema).min(1),
});

export const createPayoutSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  accountId: z.string().uuid(),
  amountCents: amountCentsSchema,
  description: z.string().max(500).optional(),
});

export const payoutWebhookSchema = z.object({
  status: z.enum(['settled', 'failed']),
  failureReason: z.string().max(200).optional(),
});

export const issueCardSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  accountId: z.string().uuid(),
  spendLimitCents: amountCentsSchema.optional(),
});

export const authorizeCardSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  amountCents: amountCentsSchema,
  merchant: z.string().min(1).max(200),
});

export const captureAuthorizationSchema = z.object({
  captureAmountCents: amountCentsSchema.optional(),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.string().datetime({ offset: true }).optional(),
});
