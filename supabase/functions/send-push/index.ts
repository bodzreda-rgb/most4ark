// Edge Function: send-push (Database Webhook on INSERT into public.notifications)
// Sends a push through FCM HTTP v1. Payloads are GENERIC on purpose (no client names, case
// titles or amounts) so nothing confidential appears on a lock screen.
// Requires secrets: FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_JSON, WEBHOOK_SECRET.
// NOTE: the web app does not register device tokens yet; this is ready for a future mobile/PWA client
// and could not be exercised without FCM credentials.
import { createClient } from 'npm:@supabase/supabase-js@2';

const GENERIC: Record<string, { ar: string; en: string }> = {
  event_reminder: { ar: 'لديك تذكير بموعد', en: 'You have an event reminder' },
  consultation_response: { ar: 'رد جديد على استشارتك', en: 'New response to your consultation' },
  consultation_assigned: { ar: 'تم إسناد استشارة إليك', en: 'A consultation was assigned to you' },
  consultation_client_reply: { ar: 'رد جديد من العميل', en: 'New client reply' },
  announcement: { ar: 'إعلان جديد من المنصة', en: 'New platform announcement' },
};

async function accessToken(sa: { client_email: string; private_key: string }) {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claim = enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claim}`)));
  const jwt = `${head}.${claim}.${btoa(String.fromCharCode(...sig)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  return (await r.json()).access_token as string;
}

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) return new Response('forbidden', { status: 403 });
  const { record } = await req.json();
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: pref } = await admin.from('notification_preferences').select('push').eq('user_id', record.user_id).eq('kind', record.kind).maybeSingle();
  if (pref && pref.push === false) return new Response('skipped');
  const { data: prof } = await admin.from('profiles').select('locale').eq('id', record.user_id).single();
  const { data: tokens } = await admin.from('device_tokens').select('token').eq('user_id', record.user_id);
  if (!tokens?.length) return new Response('no tokens');
  const lang = prof?.locale === 'en' ? 'en' : 'ar';
  const text = (GENERIC[record.kind] ?? { ar: 'لديك إشعار جديد', en: 'You have a new notification' })[lang];
  const sa = JSON.parse(Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')!);
  const token = await accessToken(sa);
  for (const t of tokens) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${Deno.env.get('FCM_PROJECT_ID')}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: t.token, notification: { title: 'مستشارك', body: text }, data: { kind: record.kind } } }),
    });
    if (r.status === 404 || r.status === 400) await admin.from('device_tokens').delete().eq('token', t.token);   // stale token
  }
  return new Response('sent');
});
