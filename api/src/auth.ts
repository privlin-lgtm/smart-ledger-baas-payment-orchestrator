import type { FastifyReply, FastifyRequest } from 'fastify';

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  throw new Error('API_KEY must be set (see api/.env.example) — every /api route requires it');
}

// Single shared-secret auth, checked on every request before it reaches a route handler.
// This is intentionally the smallest thing that closes "anyone who can reach this port can
// move money for any account" — it is not a multi-tenant auth system. A real deployment
// serving more than one operator needs per-tenant credentials and RLS policies scoped to
// them; this only establishes "you have to know the key to talk to this API at all."
export function requireApiKey(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  // CORS preflight requests never carry custom headers (that's what they're checking
  // permission to send) -- @fastify/cors answers these itself, but skip explicitly here
  // too rather than relying on hook registration order to keep preflight working.
  if (request.method === 'OPTIONS') return done();
  if (request.url === '/health') return done();

  const provided = request.headers['x-api-key'];
  if (provided !== API_KEY) {
    reply.code(401).send({ error: 'missing or invalid x-api-key header' });
    return;
  }
  done();
}
