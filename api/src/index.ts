import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { accountRoutes } from './routes/accounts.js';
import { paymentRoutes } from './routes/payments.js';
import { transactionRoutes } from './routes/transactions.js';
import { payoutRoutes } from './routes/payouts.js';
import { loadSystemAccounts } from './lib/systemAccounts.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
});

app.get('/health', async () => ({ status: 'ok' }));

await loadSystemAccounts();

await app.register(accountRoutes);
await app.register(paymentRoutes);
await app.register(transactionRoutes);
await app.register(payoutRoutes);

const port = Number(process.env.PORT ?? 8787);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
