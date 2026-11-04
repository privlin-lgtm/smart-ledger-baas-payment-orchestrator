// Run by `npm test` (pretest) so a misconfigured env stops the run before vitest starts.
import { loadTestEnv, TestEnvError } from './env-guard.js';

try {
  loadTestEnv();
  console.log('Test env OK: using a non-demo Supabase project.');
} catch (err) {
  if (err instanceof TestEnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
