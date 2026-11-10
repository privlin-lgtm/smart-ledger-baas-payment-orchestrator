import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

// The integration suite writes permanent, append-only rows to whatever Supabase project it
// points at. This guard makes sure that is a disposable test project, never the demo or
// production database. It runs twice: from `npm test`'s pretest hook (one clean refusal
// before vitest starts) and again from setup.ts (so `npx vitest` can't bypass it).

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_ENV_PATH = resolve(apiDir, '.env.test');
const APP_ENV_PATH = resolve(apiDir, '.env');

// Supabase project refs that tests must never touch. vhkkulfwrvxucmkjeemj is the shared
// demo project; xubkyfuknyfjecqzxdpx is the dedicated smart-ledger production project.
export const BLOCKED_SUPABASE_REFS = ['vhkkulfwrvxucmkjeemj', 'xubkyfuknyfjecqzxdpx'];

// Escape hatch for running with the test env already exported in the process instead of
// api/.env.test. CI no longer needs it (it writes api/.env.test from a local Supabase stack).
const FROM_PROCESS_FLAG = 'SMART_LEDGER_TEST_ENV_FROM_PROCESS';

export class TestEnvError extends Error {}

export function loadTestEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env[FROM_PROCESS_FLAG] !== 'true') {
    if (!existsSync(TEST_ENV_PATH)) {
      throw new TestEnvError(
        `Refusing to run tests: ${TEST_ENV_PATH} is missing. Copy api/.env.test.example to ` +
          'api/.env.test and point it at a disposable test Supabase project (see api/test/README.md). ' +
          'Tests never fall back to api/.env.',
      );
    }
    // The file wins over anything already exported in the shell, so a stray SUPABASE_URL
    // from another project can't leak in.
    Object.assign(env, parse(readFileSync(TEST_ENV_PATH)));
  }

  const url = env.SUPABASE_URL ?? '';
  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new TestEnvError('Refusing to run tests: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the test env.');
  }

  const blocked = BLOCKED_SUPABASE_REFS.find((ref) => url.includes(ref));
  if (blocked) {
    throw new TestEnvError(
      `Refusing to run tests: SUPABASE_URL points at ${blocked}, which is the demo/production project. ` +
        'Use a disposable test project or branch.',
    );
  }

  // Belt and braces: whatever the app itself is configured to use is off limits too.
  if (existsSync(APP_ENV_PATH)) {
    const appUrl = parse(readFileSync(APP_ENV_PATH)).SUPABASE_URL;
    if (appUrl && appUrl.replace(/\/+$/, '') === url.replace(/\/+$/, '')) {
      throw new TestEnvError(
        'Refusing to run tests: the test SUPABASE_URL is the same project api/.env uses for the app. ' +
          'Point api/.env.test at a separate test project.',
      );
    }
  }
}
