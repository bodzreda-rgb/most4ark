// Edge Function: process-reminders
// Runs on a schedule (pg_cron / Supabase Scheduled Functions, every minute).
// Calls the SECURITY DEFINER function public.process_due_reminders(), which re-checks that the
// event is still active before creating an in-app notification. The service-role key lives ONLY
// in the function's environment (Supabase injects SUPABASE_SERVICE_ROLE_KEY) — never in the web app.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('forbidden', { status: 403 });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await admin.rpc('process_due_reminders', { p_limit: 500 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  return new Response(JSON.stringify({ processed: data }), { headers: { 'content-type': 'application/json' } });
});
