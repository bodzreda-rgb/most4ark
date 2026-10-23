// Edge Function: ai-assistant — the in-app legal assistant (Google Gemini).
// Answers general questions with Google Search grounding, plus what the app itself holds:
// published library items / templates that match the question and the office's About page.
// The Gemini key never reaches the browser.
// Requires secret: GEMINI_API_KEY   (optional: GEMINI_MODEL, default gemini-2.5-flash)
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const MAX_TURNS = 12;
const MAX_CHARS = 4000;

const APP_GUIDE = `
About the "Mostshark / مستشارك" app (use this to explain how the app works):
- Clients can ask in two ways: (1) this AI assistant for quick general answers, or
  (2) "Ask a specialist lawyer": the client fills a consultation form (title, category, description,
  optional attachments). The office reviews it and assigns a verified lawyer, who replies inside the app.
  Clients follow their requests under "My consultations" and get notifications on each reply.
- Guests can use the app without an account; before sending a consultation they enter name, phone and email.
- "Lawyer directory": clients browse verified lawyers (photo, short bio, specializations, city, years of experience).
- "About": information about the office (مكتب الحلواني للمحاماة) and how to contact it.
- Lawyers use the app to manage cases, clients, calendar/hearings, finance, a legal library and document templates.
`;

function systemPrompt(lang: string, about: Record<string, string>, appContent: string) {
  const office = [about.office_name_ar, about.office_name_en].filter(Boolean).join(' / ');
  const contact = [about.phone && `Phone: ${about.phone}`, about.email && `Email: ${about.email}`,
    (about.address_ar || about.address_en) && `Address: ${about.address_ar || about.address_en}`,
    (about.hours_ar || about.hours_en) && `Hours: ${about.hours_ar || about.hours_en}`].filter(Boolean).join('\n');
  return `You are "المساعد القانوني" (the Legal Assistant) inside the Mostshark app of ${office || 'the law office'}.
Reply in ${lang === 'en' ? 'English' : 'Arabic (Modern Standard, clear and friendly)'} unless the user writes in another language.

Rules:
- Give clear, general legal information, mainly about Egyptian law, and explain basic procedures in simple words.
- You are NOT a lawyer and this is NOT legal advice. For a specific case, deadlines, court filings or anything risky,
  recommend the "Ask a specialist lawyer" option in the app. Do not mention this in every short answer, only when relevant.
- Prefer facts from the APP CONTENT below and from Google Search. Mention law names / article numbers only when
  you are confident; if unsure, say so. Never invent articles, rulings, fees or phone numbers.
- Keep answers short and structured (short paragraphs or bullet points). Use Markdown bold and lists only.
- If asked about the office or how to contact it, use the office details below; if a detail is missing, say it is not listed.
- Refuse anything harmful or illegal (e.g. forging documents, evading the law), and politely steer back to lawful options.
${APP_GUIDE}
Office details:
${about.tagline_ar || about.tagline_en || ''}
${contact || '(no contact details listed yet)'}

APP CONTENT (published items from the app's legal library and templates that may match the question):
${appContent || '(nothing matched)'}
`;
}

async function findAppContent(db: ReturnType<typeof createClient>, question: string) {
  const term = question.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter((w) => w.length > 2).slice(0, 8);
  if (!term.length) return { text: '', refs: [] as { kind: string; id: string; title: string }[] };
  const or = term.map((w) => `title.ilike.%${w}%`).join(',');
  const [byText, byTitle, tpls] = await Promise.all([
    db.from('legal_resources').select('id,title,law_name,article_number,source,body_text')
      .eq('status', 'published').textSearch('fts', term.join(' | '), { config: 'simple' }).limit(4),
    db.from('legal_resources').select('id,title,law_name,article_number,source,body_text')
      .eq('status', 'published').or(or).limit(4),
    db.from('document_templates').select('id,title,category,description')
      .eq('status', 'published').or(term.map((w) => `title.ilike.%${w}%,description.ilike.%${w}%`).join(',')).limit(3),
  ]);
  const seen = new Set<string>();
  const res = [...(byText.data || []), ...(byTitle.data || [])].filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, 4);
  const parts = res.map((r) => `[Library] ${r.title}${r.law_name ? ` — ${r.law_name}` : ''}${r.article_number ? ` (article ${r.article_number})` : ''}${r.source ? ` | source: ${r.source}` : ''}\n${(r.body_text || '').slice(0, 1500)}`);
  for (const t of tpls.data || []) parts.push(`[Template] ${t.title} (${t.category})${t.description ? `: ${t.description}` : ''}`);
  return {
    text: parts.join('\n\n---\n\n'),
    refs: [...res.map((r) => ({ kind: 'library', id: r.id, title: r.title })),
           ...(tpls.data || []).map((t) => ({ kind: 'template', id: t.id, title: t.title }))],
  };
}

async function callGemini(key: string, model: string, system: string, contents: unknown[], grounded: boolean) {
  return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      ...(grounded ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { temperature: 0.4, maxOutputTokens: 1400 },
    }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return json({ error: 'ai_not_configured' }, 503);

  const url = Deno.env.get('SUPABASE_URL')!;
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'unauthorized' }, 401);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: prof } = await admin.from('profiles').select('status,deleted_at').eq('id', user.id).maybeSingle();
  if (!prof || prof.status !== 'active' || prof.deleted_at) return json({ error: 'account_inactive' }, 403);

  let body: { messages?: { role: string; text: string }[]; lang?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const msgs = (body.messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, text: m.text.slice(0, MAX_CHARS) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json({ error: 'bad_request' }, 400);
  const lang = body.lang === 'en' ? 'en' : 'ar';

  const { data: settings } = await admin.from('platform_settings').select('key,value')
    .in('key', ['ai_daily_limit', 'ai_enabled', 'about_page']);
  const s = Object.fromEntries((settings || []).map((r) => [r.key, r.value]));
  if (s.ai_enabled === false) return json({ error: 'ai_disabled' }, 503);
  const limit = Number(s.ai_daily_limit ?? 30);
  const { data: ok } = await admin.rpc('ai_chat_take', { p_user: user.id, p_limit: limit });
  if (ok === false) return json({ error: 'ai_daily_limit' }, 429);

  const question = msgs[msgs.length - 1].text;
  const app = await findAppContent(admin, question);
  const system = systemPrompt(lang, (s.about_page || {}) as Record<string, string>, app.text);
  const contents = msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';

  // Search grounding first; if the key/model has no grounding quota, answer without it.
  let r = await callGemini(key, model, system, contents, true);
  if (!r.ok && (r.status === 400 || r.status === 403 || r.status === 429)) {
    console.warn('grounded call failed', r.status, (await r.text()).slice(0, 300));
    r = await callGemini(key, model, system, contents, false);
  }
  if (!r.ok) {
    console.error('gemini error', r.status, (await r.text()).slice(0, 500));
    return json({ error: r.status === 429 ? 'ai_busy' : 'ai_failed' }, 502);
  }
  const out = await r.json();
  const cand = out.candidates?.[0];
  const reply = (cand?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('').trim();
  if (!reply) return json({ error: cand?.finishReason === 'SAFETY' ? 'ai_blocked' : 'ai_failed' }, 502);
  const web = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c: { web?: { uri: string; title: string } }) => c.web).filter(Boolean)
    .slice(0, 5).map((w: { uri: string; title: string }) => ({ title: w.title, url: w.uri }));

  return json({ reply, sources: web, used_app_content: app.refs.length > 0 });
});
