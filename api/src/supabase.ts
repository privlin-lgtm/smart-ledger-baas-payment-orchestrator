import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see api/.env.example)');
}

// Service-role client: bypasses RLS, used only server-side. The API layer below is the
// sole gate on reads/writes — never ship this key to a browser.
export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
});
