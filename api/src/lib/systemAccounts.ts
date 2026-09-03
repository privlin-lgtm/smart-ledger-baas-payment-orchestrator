import { supabase } from '../supabase.js';

// Internal ledger-only accounts the payout and card-authorization engines post against.
// Seeded by migration (accounts_system_name_unique enforces exactly one of each); resolved
// by name at boot so the API never hardcodes their generated ids.
const SYSTEM_ACCOUNT_NAMES = [
  'Payouts Clearing',
  'External Bank Rail',
  'Card Holds',
  'Card Network Settlement',
] as const;
type SystemAccountName = (typeof SYSTEM_ACCOUNT_NAMES)[number];

let systemAccountIds: Record<SystemAccountName, string> | null = null;

export async function loadSystemAccounts(): Promise<void> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, name')
    .eq('type', 'system')
    .in('name', SYSTEM_ACCOUNT_NAMES);

  if (error) throw new Error(`failed to load system accounts: ${error.message}`);

  const byName = new Map(data.map((row) => [row.name, row.id]));
  const missing = SYSTEM_ACCOUNT_NAMES.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`missing system account(s), run the migration: ${missing.join(', ')}`);
  }

  systemAccountIds = Object.fromEntries(
    SYSTEM_ACCOUNT_NAMES.map((name) => [name, byName.get(name)!]),
  ) as Record<SystemAccountName, string>;
}

export function getSystemAccountId(name: SystemAccountName): string {
  if (!systemAccountIds) throw new Error('system accounts not loaded — call loadSystemAccounts() at startup');
  return systemAccountIds[name];
}
