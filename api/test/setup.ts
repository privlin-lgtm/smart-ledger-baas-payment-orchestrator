import 'dotenv/config';

process.env.NODE_ENV = 'test';
// The suite legitimately fires more requests per minute than the dev-facing default
// rate limit allows; raise it for this process only so tests aren't flaky because of it.
process.env.RATE_LIMIT_MAX = '10000';
