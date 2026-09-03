import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { accountRoutes } from './routes/accounts.js';
import { paymentRoutes } from './routes/payments.js';
import { transactionRoutes } from './routes/transactions.js';
import { payoutRoutes } from './routes/payouts.js';
import { cardRoutes } from './routes/cards.js';
import { loadSystemAccounts } from './lib/systemAccounts.js';
import { requireApiKey } from './auth.js';

// Builds and fully registers the app without binding a port, so tests can drive it via
// `app.inject()` and the real entrypoint (index.ts) can just add `.listen()`.
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  });

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
    timeWindow: '1 minute',
  });

  app.addHook('onRequest', requireApiKey);

  // Fastify's default JSON parser rejects an empty body when Content-Type is
  // application/json (FST_ERR_CTP_EMPTY_JSON_BODY) -- but a bodyless action route
  // (freeze/unfreeze/cancel/reverse) is a legitimate request, not a malformed one.
  // Treat an empty body as `{}` rather than trusting every client to omit the header.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await loadSystemAccounts();

  await app.register(accountRoutes);
  await app.register(paymentRoutes);
  await app.register(transactionRoutes);
  await app.register(payoutRoutes);
  await app.register(cardRoutes);

  return app;
}
