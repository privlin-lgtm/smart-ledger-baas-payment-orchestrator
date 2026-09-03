import { randomUUID } from 'node:crypto';
import { supabase } from '../supabase.js';
import { getSystemAccountId } from './systemAccounts.js';
import { settleOpenRecord } from './ledgerSettlement.js';

const SETTLEMENT_DELAY_MS_MIN = Number(process.env.PAYOUT_SETTLEMENT_DELAY_MS_MIN ?? 3000);
const SETTLEMENT_DELAY_MS_MAX = Number(process.env.PAYOUT_SETTLEMENT_DELAY_MS_MAX ?? 8000);
const FAILURE_RATE = Number(process.env.PAYOUT_FAILURE_RATE ?? 0.15);

const SIMULATED_FAILURE_REASONS = [
  'bank_account_closed',
  'compliance_hold',
  'invalid_routing_number',
  'processor_timeout',
];

interface PayoutRow {
  id: string;
  idempotency_key: string;
  account_id: string;
  amount_cents: number;
  status: 'processing' | 'settled' | 'failed';
}

export interface PayoutOutcome {
  status: 'settled' | 'failed';
  failureReason?: string;
}

function randomOutcome(): PayoutOutcome {
  if (Math.random() < FAILURE_RATE) {
    const reason = SIMULATED_FAILURE_REASONS[Math.floor(Math.random() * SIMULATED_FAILURE_REASONS.length)];
    return { status: 'failed', failureReason: reason };
  }
  return { status: 'settled' };
}

// Mimics a real BaaS provider's async transfer webhook: schedule this right after the hold
// is posted, as if we'd just called their "create transfer" endpoint and are waiting for
// their callback. `forcedOutcome` lets the demo UI / a manual webhook call skip the wait.
export function scheduleSimulatedSettlement(payoutId: string): void {
  const delay = SETTLEMENT_DELAY_MS_MIN + Math.random() * (SETTLEMENT_DELAY_MS_MAX - SETTLEMENT_DELAY_MS_MIN);
  setTimeout(() => {
    applyPayoutOutcome(payoutId, randomOutcome()).catch((err) => {
      console.error(`simulated settlement failed for payout ${payoutId}:`, err);
    });
  }, delay);
}

// Idempotent: a payout already out of 'processing' is left untouched and its current row
// is returned, so a replayed webhook (real processors retry) or a race with the scheduled
// timer never double-posts a settlement transaction.
export async function applyPayoutOutcome(payoutId: string, outcome: PayoutOutcome): Promise<PayoutRow | null> {
  const { data: payout, error: fetchError } = await supabase
    .from('payouts')
    .select('id, idempotency_key, account_id, amount_cents, status')
    .eq('id', payoutId)
    .maybeSingle<PayoutRow>();

  if (fetchError) throw new Error(fetchError.message);
  if (!payout) return null;
  if (payout.status !== 'processing') return payout;

  const clearingAccountId = getSystemAccountId('Payouts Clearing');

  const result =
    outcome.status === 'settled'
      ? await settleOpenRecord<PayoutRow>({
          table: 'payouts',
          id: payoutId,
          openStatus: 'processing',
          idempotencyKey: `${payout.idempotency_key}:settle`,
          description: `Payout ${payout.id} settled via simulated bank rail`,
          entries: [
              { account_id: clearingAccountId, amount_cents: -payout.amount_cents },
              { account_id: getSystemAccountId('External Bank Rail'), amount_cents: payout.amount_cents },
          ],
          updateFields: {
            status: 'settled',
            external_reference: `sim_${randomUUID()}`,
            settled_at: new Date().toISOString(),
          },
        })
      : await settleOpenRecord<PayoutRow>({
          table: 'payouts',
          id: payoutId,
          openStatus: 'processing',
          idempotencyKey: `${payout.idempotency_key}:fail`,
          description: `Payout ${payout.id} failed: ${outcome.failureReason ?? 'unknown'}`,
          entries: [
              { account_id: clearingAccountId, amount_cents: -payout.amount_cents },
              { account_id: payout.account_id, amount_cents: payout.amount_cents },
          ],
          updateFields: {
            status: 'failed',
            failure_reason: outcome.failureReason ?? 'unknown',
            failed_at: new Date().toISOString(),
          },
        });

  if ('error' in result) throw new Error(result.error);
  return result;
}
