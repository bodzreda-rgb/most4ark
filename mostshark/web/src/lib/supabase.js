import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Only the public anon key is ever used in the browser. All privileged work is
// performed by RLS-protected tables and SECURITY DEFINER functions server-side.
export const isConfigured = Boolean(url && anon);

export const supabase = isConfigured
  ? createClient(url, anon, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
