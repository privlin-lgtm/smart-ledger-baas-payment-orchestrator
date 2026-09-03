import { useEffect, useState } from 'react';
import {
  type AccountBalance,
  type AccountType,
  type Card,
  type CardAuthorization,
  type Payout,
  type TransactionSummary,
  authorizeCard,
  captureAuthorization,
  createAccount,
  issueCard,
  listAccounts,
  listCardAuthorizations,
  listCards,
  listPayouts,
  listTransactions,
  postSplitPayment,
  requestPayout,
  reverseAuthorization,
  sendPayoutWebhook,
  setCardStatus,
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
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState<AccountType>('business');

  const [sourceAccountId, setSourceAccountId] = useState('');
  const [amountDollars, setAmountDollars] = useState('');
  const [description, setDescription] = useState('');
  const [splits, setSplits] = useState<SplitRow[]>([{ accountId: '', amountDollars: '', kind: 'payout' }]);

  const [payoutAccountId, setPayoutAccountId] = useState('');
  const [payoutAmountDollars, setPayoutAmountDollars] = useState('');
  const [payoutDescription, setPayoutDescription] = useState('');

  const [cards, setCards] = useState<Card[]>([]);
  const [authorizations, setAuthorizations] = useState<CardAuthorization[]>([]);
  const [cardAccountId, setCardAccountId] = useState('');
  const [cardSpendLimitDollars, setCardSpendLimitDollars] = useState('');

  const [authCardId, setAuthCardId] = useState('');
  const [authAmountDollars, setAuthAmountDollars] = useState('');
  const [authMerchant, setAuthMerchant] = useState('');

  // Real customer accounts only — the payout/clearing rail accounts are ledger-internal
  // and shouldn't be picked as a source, recipient, or payout destination by hand.
  const payableAccounts = accounts.filter((a) => a.type !== 'system');
  const activeCards = cards.filter((c) => c.status === 'active');

  async function refresh() {
    const [accountsData, transactionsData, payoutsData, cardsData, authorizationsData] = await Promise.all([
      listAccounts(),
      listTransactions(),
      listPayouts(),
      listCards(),
      listCardAuthorizations(),
    ]);
    setAccounts(accountsData);
    setTransactions(transactionsData);
    setPayouts(payoutsData);
    setCards(cardsData);
    setAuthorizations(authorizationsData);
  }

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, []);

  // Payouts settle asynchronously on the server (simulated bank-rail delay), so poll while
  // any are still in flight to reflect the status change without a manual refresh.
  useEffect(() => {
    if (!payouts.some((p) => p.status === 'processing')) return;
    const id = setInterval(() => {
      refresh().catch((err: Error) => setError(err.message));
    }, 2000);
    return () => clearInterval(id);
  }, [payouts]);

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

  async function handleRequestPayout(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const amountCents = dollarsToCents(payoutAmountDollars || '0');
    if (!payoutAccountId) return setError('choose an account to pay out from');
    if (amountCents <= 0) return setError('enter a payout amount greater than zero');

    try {
      await requestPayout({
        idempotencyKey: crypto.randomUUID(),
        accountId: payoutAccountId,
        amountCents,
        description: payoutDescription || undefined,
      });
      setPayoutAmountDollars('');
      setPayoutDescription('');
      await refresh();
      setNotice('Payout requested — funds held, awaiting simulated bank-rail settlement');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleSimulateWebhook(payoutId: string, status: 'settled' | 'failed') {
    setError(null);
    setNotice(null);
    try {
      await sendPayoutWebhook(payoutId, status, status === 'failed' ? 'manually triggered from console' : undefined);
      await refresh();
      setNotice(`Simulated bank-rail webhook: payout ${status}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleIssueCard(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!cardAccountId) return setError('choose an account to issue the card for');

    try {
      const card = await issueCard({
        idempotencyKey: crypto.randomUUID(),
        accountId: cardAccountId,
        spendLimitCents: cardSpendLimitDollars ? dollarsToCents(cardSpendLimitDollars) : undefined,
      });
      setCardSpendLimitDollars('');
      await refresh();
      setNotice(`Issued card ending in ${card.last4}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCardStatus(cardId: string, action: 'freeze' | 'unfreeze' | 'cancel') {
    setError(null);
    setNotice(null);
    try {
      await setCardStatus(cardId, action);
      await refresh();
      setNotice(`Card ${action === 'unfreeze' ? 'reactivated' : action + 'd'}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAuthorize(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const amountCents = dollarsToCents(authAmountDollars || '0');
    if (!authCardId) return setError('choose a card');
    if (amountCents <= 0) return setError('enter an amount greater than zero');
    if (!authMerchant) return setError('enter a merchant name');

    try {
      const auth = await authorizeCard(authCardId, {
        idempotencyKey: crypto.randomUUID(),
        amountCents,
        merchant: authMerchant,
      });
      setAuthAmountDollars('');
      setAuthMerchant('');
      await refresh();
      setNotice(
        auth.status === 'declined'
          ? `Declined: ${auth.decline_reason}`
          : `Authorized ${formatCents(auth.amount_cents)} at ${auth.merchant}`,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCapture(authorizationId: string) {
    setError(null);
    setNotice(null);
    try {
      await captureAuthorization(authorizationId);
      await refresh();
      setNotice('Authorization captured');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleReverse(authorizationId: string) {
    setError(null);
    setNotice(null);
    try {
      await reverseAuthorization(authorizationId);
      await refresh();
      setNotice('Authorization reversed — hold released');
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
                {payableAccounts.map((a) => (
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
                  {payableAccounts
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

        <section className="panel panel-wide">
          <h2>Request a payout</h2>
          <p className="hint">
            Holds funds immediately, then settles or fails a few seconds later via a simulated bank-rail
            webhook — or trigger the webhook yourself below.
          </p>
          <form className="form" onSubmit={handleRequestPayout}>
            <label>
              Account
              <select value={payoutAccountId} onChange={(e) => setPayoutAccountId(e.target.value)} required>
                <option value="">Select an account</option>
                {payableAccounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.name} ({formatCents(a.balance_cents)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount (USD)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={payoutAmountDollars}
                onChange={(e) => setPayoutAmountDollars(e.target.value)}
                placeholder="50.00"
                required
              />
            </label>
            <label>
              Description
              <input
                value={payoutDescription}
                onChange={(e) => setPayoutDescription(e.target.value)}
                placeholder="Weekly supplier payout"
              />
            </label>
            <button type="submit">Request payout</button>
          </form>

          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Detail</th>
                <th>Requested</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id}>
                  <td>{p.accounts?.name ?? p.account_id}</td>
                  <td>{formatCents(p.amount_cents)}</td>
                  <td>
                    <span className={`badge badge-payout-${p.status}`}>{p.status}</span>
                  </td>
                  <td className="mono">
                    {p.status === 'settled' && p.external_reference}
                    {p.status === 'failed' && p.failure_reason}
                  </td>
                  <td>{new Date(p.requested_at).toLocaleString()}</td>
                  <td>
                    {p.status === 'processing' && (
                      <div className="payout-actions">
                        <button type="button" className="ghost" onClick={() => handleSimulateWebhook(p.id, 'settled')}>
                          Simulate success
                        </button>
                        <button type="button" className="ghost" onClick={() => handleSimulateWebhook(p.id, 'failed')}>
                          Simulate failure
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {payouts.length === 0 && (
                <tr>
                  <td colSpan={6}>No payouts yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>Cards</h2>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Card</th>
                <th>Limit</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id}>
                  <td>{c.accounts?.name ?? c.account_id}</td>
                  <td className="mono">
                    {c.network} •••• {c.last4}
                  </td>
                  <td>{c.spend_limit_cents === null ? '—' : formatCents(c.spend_limit_cents)}</td>
                  <td>
                    <span className={`badge badge-card-${c.status}`}>{c.status}</span>
                  </td>
                  <td>
                    <div className="payout-actions">
                      {c.status === 'active' && (
                        <>
                          <button type="button" className="ghost" onClick={() => handleCardStatus(c.id, 'freeze')}>
                            Freeze
                          </button>
                          <button type="button" className="ghost" onClick={() => handleCardStatus(c.id, 'cancel')}>
                            Cancel
                          </button>
                        </>
                      )}
                      {c.status === 'frozen' && (
                        <>
                          <button type="button" className="ghost" onClick={() => handleCardStatus(c.id, 'unfreeze')}>
                            Unfreeze
                          </button>
                          <button type="button" className="ghost" onClick={() => handleCardStatus(c.id, 'cancel')}>
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {cards.length === 0 && (
                <tr>
                  <td colSpan={5}>No cards yet — issue one below.</td>
                </tr>
              )}
            </tbody>
          </table>

          <form className="form" onSubmit={handleIssueCard}>
            <h3>Issue a card</h3>
            <label>
              Account
              <select value={cardAccountId} onChange={(e) => setCardAccountId(e.target.value)} required>
                <option value="">Select an account</option>
                {payableAccounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Per-transaction limit (USD, optional)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={cardSpendLimitDollars}
                onChange={(e) => setCardSpendLimitDollars(e.target.value)}
                placeholder="No limit"
              />
            </label>
            <button type="submit">Issue card</button>
          </form>
        </section>

        <section className="panel panel-wide">
          <h2>Authorize a card transaction</h2>
          <p className="hint">
            Card authorizations decide synchronously — approved (funds held) or declined — just like a real
            card network. Capture to pay the merchant, or reverse to void the hold.
          </p>
          <form className="form" onSubmit={handleAuthorize}>
            <label>
              Card
              <select value={authCardId} onChange={(e) => setAuthCardId(e.target.value)} required>
                <option value="">Select a card</option>
                {activeCards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.accounts?.name ?? c.account_id} — •••• {c.last4}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount (USD)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={authAmountDollars}
                onChange={(e) => setAuthAmountDollars(e.target.value)}
                placeholder="25.00"
                required
              />
            </label>
            <label>
              Merchant
              <input
                value={authMerchant}
                onChange={(e) => setAuthMerchant(e.target.value)}
                placeholder="Office Depot"
                required
              />
            </label>
            <button type="submit">Authorize</button>
          </form>

          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Card</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Detail</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {authorizations.map((a) => (
                <tr key={a.id}>
                  <td>{a.accounts?.name ?? a.account_id}</td>
                  <td className="mono">{a.cards ? `•••• ${a.cards.last4}` : a.card_id}</td>
                  <td>{a.merchant}</td>
                  <td>
                    {formatCents(a.amount_cents)}
                    {a.status === 'captured' &&
                      a.captured_amount_cents !== null &&
                      a.captured_amount_cents !== a.amount_cents &&
                      ` (captured ${formatCents(a.captured_amount_cents)})`}
                  </td>
                  <td>
                    <span className={`badge badge-auth-${a.status}`}>{a.status}</span>
                  </td>
                  <td className="mono">{a.status === 'declined' && a.decline_reason}</td>
                  <td>
                    {a.status === 'authorized' && (
                      <div className="payout-actions">
                        <button type="button" className="ghost" onClick={() => handleCapture(a.id)}>
                          Capture
                        </button>
                        <button type="button" className="ghost" onClick={() => handleReverse(a.id)}>
                          Reverse
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {authorizations.length === 0 && (
                <tr>
                  <td colSpan={7}>No authorizations yet.</td>
                </tr>
              )}
            </tbody>
          </table>
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
