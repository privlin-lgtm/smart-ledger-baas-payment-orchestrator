import { useEffect, useState } from 'react';
import {
  type AccountBalance,
  type AccountType,
  type TransactionSummary,
  createAccount,
  listAccounts,
  listTransactions,
  postSplitPayment,
} from './api';

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function dollarsToCents(value: string): number {
  const amount = Number(value);
  return Math.round(amount * 100);
}

interface SplitRow {
  accountId: string;
  amountDollars: string;
  kind: string;
}

export default function App() {
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [transactions, setTransactions] = useState<TransactionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState<AccountType>('business');

  const [sourceAccountId, setSourceAccountId] = useState('');
  const [amountDollars, setAmountDollars] = useState('');
  const [description, setDescription] = useState('');
  const [splits, setSplits] = useState<SplitRow[]>([{ accountId: '', amountDollars: '', kind: 'payout' }]);

  async function refresh() {
    const [accountsData, transactionsData] = await Promise.all([listAccounts(), listTransactions()]);
    setAccounts(accountsData);
    setTransactions(transactionsData);
  }

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, []);

  const totalCents = dollarsToCents(amountDollars || '0');
  const splitTotalCents = splits.reduce((sum, s) => sum + dollarsToCents(s.amountDollars || '0'), 0);
  const remainingCents = totalCents - splitTotalCents;

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createAccount({ name: newAccountName, type: newAccountType });
      setNewAccountName('');
      await refresh();
      setNotice(`Created account "${newAccountName}"`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function updateSplit(index: number, patch: Partial<SplitRow>) {
    setSplits((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addSplit() {
    setSplits((rows) => [...rows, { accountId: '', amountDollars: '', kind: '' }]);
  }

  function removeSplit(index: number) {
    setSplits((rows) => rows.filter((_, i) => i !== index));
  }

  async function handleSplitPayment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!sourceAccountId) return setError('choose a source account');
    if (totalCents <= 0) return setError('enter a total amount greater than zero');
    if (remainingCents !== 0) {
      return setError(`splits must add up to the total: ${formatCents(remainingCents)} unallocated`);
    }

    try {
      const { transactionId } = await postSplitPayment({
        idempotencyKey: crypto.randomUUID(),
        description: description || undefined,
        sourceAccountId,
        amountCents: totalCents,
        splits: splits.map((s) => ({
          accountId: s.accountId,
          amountCents: dollarsToCents(s.amountDollars || '0'),
          kind: s.kind || undefined,
        })),
      });
      setAmountDollars('');
      setDescription('');
      setSplits([{ accountId: '', amountDollars: '', kind: 'payout' }]);
      await refresh();
      setNotice(`Posted transaction ${transactionId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Sub-Ledger Console</h1>
        <p>Embeddable split-payment ledger — demo control panel</p>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {notice && <div className="banner banner-ok">{notice}</div>}

      <div className="grid">
        <section className="panel">
          <h2>Accounts</h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.account_id}>
                  <td>{a.name}</td>
                  <td>
                    <span className={`badge badge-${a.type}`}>{a.type}</span>
                  </td>
                  <td className={a.balance_cents < 0 ? 'negative' : ''}>{formatCents(a.balance_cents)}</td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={3}>No accounts yet — create one below.</td>
                </tr>
              )}
            </tbody>
          </table>

          <form className="form" onSubmit={handleCreateAccount}>
            <h3>New account</h3>
            <label>
              Name
              <input
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="Acme Supplies"
                required
              />
            </label>
            <label>
              Type
              <select value={newAccountType} onChange={(e) => setNewAccountType(e.target.value as AccountType)}>
                <option value="platform">platform</option>
                <option value="supplier">supplier</option>
                <option value="business">business</option>
              </select>
            </label>
            <button type="submit">Create account</button>
          </form>
        </section>

        <section className="panel">
          <h2>Post a split payment</h2>
          <form className="form" onSubmit={handleSplitPayment}>
            <label>
              Source account
              <select value={sourceAccountId} onChange={(e) => setSourceAccountId(e.target.value)} required>
                <option value="">Select an account</option>
                {accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.name} ({formatCents(a.balance_cents)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Total amount (USD)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                placeholder="100.00"
                required
              />
            </label>
            <label>
              Description
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Order #1042" />
            </label>

            <h3>Splits</h3>
            {splits.map((row, i) => (
              <div className="split-row" key={i}>
                <select value={row.accountId} onChange={(e) => updateSplit(i, { accountId: e.target.value })} required>
                  <option value="">Recipient</option>
                  {accounts
                    .filter((a) => a.account_id !== sourceAccountId)
                    .map((a) => (
                      <option key={a.account_id} value={a.account_id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={row.amountDollars}
                  onChange={(e) => updateSplit(i, { amountDollars: e.target.value })}
                  placeholder="0.00"
                  required
                />
                <input
                  value={row.kind}
                  onChange={(e) => updateSplit(i, { kind: e.target.value })}
                  placeholder="kind (e.g. payout, fee)"
                />
                <button type="button" className="ghost" onClick={() => removeSplit(i)} disabled={splits.length === 1}>
                  &times;
                </button>
              </div>
            ))}
            <button type="button" className="ghost" onClick={addSplit}>
              + Add split
            </button>

            <div className={`remaining ${remainingCents !== 0 ? 'negative' : ''}`}>
              Unallocated: {formatCents(remainingCents)}
            </div>

            <button type="submit">Post transaction</button>
          </form>
        </section>

        <section className="panel">
          <h2>Recent transactions</h2>
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Idempotency key</th>
                <th>Posted</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.description ?? '—'}</td>
                  <td className="mono">{t.idempotency_key}</td>
                  <td>{new Date(t.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={3}>No transactions yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
