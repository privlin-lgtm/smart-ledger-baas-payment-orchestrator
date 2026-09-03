import { z } from 'zod';

export const createAccountSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['platform', 'supplier', 'business']),
});

export const splitSchema = z.object({
  accountId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  kind: z.string().min(1).max(50).optional(),
});

export const splitPaymentSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  sourceAccountId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  splits: z.array(splitSchema).min(1),
});

export const createPayoutSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  accountId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  description: z.string().max(500).optional(),
});

export const payoutWebhookSchema = z.object({
  status: z.enum(['settled', 'failed']),
  failureReason: z.string().max(200).optional(),
});
