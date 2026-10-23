import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { Button, PageHead } from '../../components/ui.jsx';

const AI_ERRORS = ['ai_not_configured', 'ai_disabled', 'ai_daily_limit', 'ai_busy', 'ai_blocked', 'account_inactive'];
const SUGGESTIONS = ['ai.sug.1', 'ai.sug.2', 'ai.sug.3', 'ai.sug.4'];

const storeKey = (uid) => `ms_ai_chat_${uid}`;
function loadChat(uid) {
  try { const v = JSON.parse(localStorage.getItem(storeKey(uid)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveChat(uid, msgs) {
  try { localStorage.setItem(storeKey(uid), JSON.stringify(msgs.slice(-40))); } catch { /* storage unavailable */ }
}

/** Tiny, safe Markdown: **bold**, bullet and numbered lists, paragraphs. Never uses innerHTML. */
function inline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));
}
export function RichText({ text }) {
  const blocks = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) {
      const ordered = /^\s*\d/.test(line);
      if (!list || list.ordered !== ordered) { list = { ordered, items: [] }; blocks.push(list); }
      list.items.push(m[1]);
    } else {
      list = null;
      if (line.trim()) blocks.push(line.replace(/^#+\s*/, ''));
    }
  }
  return blocks.map((b, i) => (typeof b === 'string'
    ? <p key={i}>{inline(b)}</p>
    : b.ordered ? <ol key={i}>{b.items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ol>
      : <ul key={i}>{b.items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ul>));
}

async function errorCodeOf(error) {
  try { const body = await error.context?.json(); if (body?.error) return body.error; } catch { /* not json */ }
  return 'ai_failed';
}

export default function AiChat() {
  const { t, lang } = useI18n();
  const { user, profile } = useAuth();
  const nav = useNavigate();
  const [msgs, setMsgs] = useState(() => loadChat(user.id));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const isClient = profile?.account_type === 'client';

  useEffect(() => { saveChat(user.id, msgs); }, [user.id, msgs]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy]);

  const send = async (q, history = msgs) => {
    const question = (q ?? text).trim();
    if (!question || busy) return;
    const next = [...history, { role: 'user', text: question }];
    setMsgs(next); setText(''); setErr(null); setBusy(true);
    const { data, error } = await supabase.functions.invoke('ai-assistant', {
      body: { lang, messages: next.map(({ role, text: m }) => ({ role, text: m })) },
    });
    if (error || !data?.reply) {
      const code = error ? await errorCodeOf(error) : 'ai_failed';
      setErr(AI_ERRORS.includes(code) ? code : 'ai_failed');
    } else {
      setMsgs([...next, { role: 'assistant', text: data.reply, sources: data.sources || [] }]);
    }
    setBusy(false);
    inputRef.current?.focus();
  };

  // the failed question is still the last message: ask it again without duplicating it
  const retry = () => send(msgs[msgs.length - 1].text, msgs.slice(0, -1));

  const toLawyer = () => {
    const firstQ = msgs.find((m) => m.role === 'user')?.text || '';
    const transcript = msgs.map((m) => `${m.role === 'user' ? t('ai.me') : t('ai.name')}: ${m.text}`).join('\n\n');
    nav('/client/new', { state: { prefill: { title: firstQ.slice(0, 120), description: `${firstQ}\n\n— ${t('ai.transcript')} —\n${transcript}`.slice(0, 8000) } } });
  };

  return (
    <>
      <PageHead title={t('ai.title')} subtitle={t('ai.subtitle')} />
      <section className="chat" aria-label={t('ai.title')}>
        <div className="chat-head">
          <span className="bot-avatar" aria-hidden="true">⚖️</span>
          <div className="grow"><strong>{t('ai.name')}</strong><div className="small muted"><span className="dot-online" /> {t('ai.powered')}</div></div>
          {msgs.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setMsgs([]); setErr(null); }}>🧹 {t('ai.clear')}</Button>}
        </div>

        <div className="chat-body" aria-live="polite">
          {msgs.length === 0 && (
            <div className="chat-welcome">
              <div className="bot-avatar big" aria-hidden="true">⚖️</div>
              <h2>{t('ai.hello', { name: profile?.full_name?.split(' ')[0] || '' })}</h2>
              <p className="muted">{t('ai.intro')}</p>
              <div className="chat-suggestions">
                {SUGGESTIONS.map((k) => <button key={k} type="button" className="suggestion" onClick={() => send(t(k))}>{t(k)}</button>)}
              </div>
            </div>)}
          {msgs.map((m, i) => (
            <div key={i} className={`bubble-row ${m.role}`}>
              {m.role === 'assistant' && <span className="bot-avatar sm" aria-hidden="true">⚖️</span>}
              <div className={`bubble ${m.role}`}>
                {m.role === 'assistant' ? <RichText text={m.text} /> : <p>{m.text}</p>}
                {m.sources?.length > 0 && (
                  <div className="bubble-sources"><span className="small muted">🔎 {t('ai.sources')}:</span>
                    {m.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="source-chip">{s.title || new URL(s.url).hostname}</a>)}
                  </div>)}
              </div>
            </div>))}
          {busy && <div className="bubble-row assistant"><span className="bot-avatar sm" aria-hidden="true">⚖️</span><div className="bubble assistant typing" aria-label={t('ai.thinking')}><i /><i /><i /></div></div>}
          {err && <div className="alert danger small" role="alert">{t(`ai.err.${err}`)} {err !== 'ai_daily_limit' && msgs[msgs.length - 1]?.role === 'user' && <button className="btn btn-sm btn-secondary" onClick={retry}>{t('common.retry')}</button>}</div>}
          <div ref={endRef} />
        </div>

        {isClient && msgs.some((m) => m.role === 'assistant') && (
          <div className="chat-escalate">
            <span className="small">{t('ai.need_lawyer')}</span>
            <Button size="sm" variant="primary" onClick={toLawyer}>⚖️ {t('ai.send_to_lawyer')}</Button>
          </div>)}

        <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <textarea ref={inputRef} className="input" rows={1} value={text} maxLength={4000} placeholder={t('ai.placeholder')} aria-label={t('ai.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button variant="primary" type="submit" disabled={busy || !text.trim()} aria-label={t('ai.send')}>➤</Button>
        </form>
        <p className="small muted chat-disclaimer">{t('ai.disclaimer')}</p>
      </section>
    </>);
}
