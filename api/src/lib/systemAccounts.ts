import { supabase } from '../supabase.js';

// Internal ledger-only accounts the payout engine posts against. Seeded by migration
// (accounts_system_name_unique enforces exactly one of each); resolved by name at boot
// so the API never hardcodes their generated ids.
const SYSTEM_ACCOUNT_NAMES = ['Payouts Clearing', 'External Bank Rail'] as const;
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

  systemAccountIds = {
    'Payouts Clearing': byName.get('Payouts Clearing')!,
    'External Bank Rail': byName.get('External Bank Rail')!,
  };
}

export function getSystemAccountId(name: SystemAccountName): string {
  if (!systemAccountIds) throw new Error('system accounts not loaded — call loadSystemAccounts() at startup');
  return systemAccountIds[name];
}
