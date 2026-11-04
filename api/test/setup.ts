import { loadTestEnv } from './env-guard.js';

// Load api/.env.test (never api/.env) and refuse to continue if it's missing or points at
// the demo project. This must run before anything imports src/supabase.ts.
loadTestEnv();

process.env.NODE_ENV = 'test';
// The suite legitimately fires more requests per minute than the dev-facing default
// rate limit allows; raise it for this process only so tests aren't flaky because of it.
process.env.RATE_LIMIT_MAX = '10000';
