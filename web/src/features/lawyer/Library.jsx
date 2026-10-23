import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDate } from '../../lib/dates.js';
import { openSigned } from '../../lib/storage.js';
import { usePublicSettings } from '../../lib/settings.js';
import { Alert, AsyncView, Button, Disclaimer, Card, Empty, Field, KV, Modal, PageHead, SearchBox, Select, StatusBadge, Tabs, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

export const RESOURCE_TYPES = ['law', 'article', 'constitutional', 'bar_resource', 'civil_commercial', 'criminal', 'procedure', 'evidence', 'labor', 'personal_status', 'administrative', 'regulation', 'judgment', 'principle', 'form', 'contract', 'pleading', 'memo', 'circular', 'reference', 'other'];

export function VerificationNotice({ r }) {
  const { t } = useI18n();
  if (r.verification_status === 'verified') return null;
  return <Alert tone="warn">⚠️ {r.verification_status === 'outdated' ? t('lib.outdated_warning') : t('lib.unverified_warning')}</Alert>;
}

export default function Library() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const nav = useNavigate();
  const { disclaimer } = usePublicSettings();
  const [tab, setTab] = useState('search');
  const [f, setF] = useState({ q: '', type: '', category: '', article: '' });
  const dq = useDebounced(f.q); const dart = useDebounced(f.article);
  const cats = useAsync(async () => unwrap(await supabase.from('library_categories').select('*').eq('is_active', true).order('sort_order')), []);
  const state = useAsync(async () => {
    if (tab === 'bookmarks') {
      const b = unwrap(await supabase.from('resource_bookmarks').select('resource_id').order('created_at', { ascending: false }));
      if (!b.length) return [];
      return unwrap(await supabase.from('legal_resources').select('*').in('id', b.map((x) => x.resource_id)));
    }
    if (tab === 'recent') {
      const v = unwrap(await supabase.from('resource_views').select('resource_id,viewed_at').order('viewed_at', { ascending: false }).limit(20));
      if (!v.length) return [];
      const rows = unwrap(await supabase.from('legal_resources').select('*').in('id', v.map((x) => x.resource_id)));
      return v.map((x) => rows.find((r) => r.id === x.resource_id)).filter(Boolean);
    }
    let q = supabase.from('legal_resources').select('*').order('updated_at', { ascending: false }).limit(60);
    if (f.type) q = q.eq('resource_type', f.type);
    if (f.category) q = q.eq('category_id', Number(f.category));
    const art = safeTerm(dart);
    if (art) q = q.ilike('article_number', `${art}`);
    const term = safeTerm(dq);
    if (term) q = q.or(`title.ilike.%${term}%,law_name.ilike.%${term}%,article_number.ilike.%${term}%,fts.wfts(simple).${term.split(/\s+/).join(' ')}`);
    return unwrap(await q);
  }, [tab, f.type, f.category, dq, dart]);
  const catName = (id) => { const c = (cats.data || []).find((x) => x.id === id); return c ? (lang === 'ar' ? c.name_ar : c.name_en) : null; };

  return (
    <>
      <PageHead title={t('nav.library')} subtitle={t('lib.subtitle')} />
      <Disclaimer text={disclaimer('library')} />
      <div style={{ marginTop: 16 }}>
        <Tabs value={tab} onChange={setTab} items={[{ value: 'search', label: t('lib.tab.search') }, { value: 'bookmarks', label: t('lib.tab.bookmarks') }, { value: 'recent', label: t('lib.tab.recent') }]} />
        {tab === 'search' && (
          <div className="card flat grid cols-4" style={{ marginBottom: 16 }}>
            <Field label={t('lib.search_label')}><SearchBox value={f.q} onChange={(v) => setF({ ...f, q: v })} placeholder={t('lib.search_hint')} /></Field>
            <Field label={t('lib.article_no')}><input className="input ltr" value={f.article} onChange={(e) => setF({ ...f, article: e.target.value })} /></Field>
            <Field label={t('lib.type')}><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">{t('common.all')}</option>
              {RESOURCE_TYPES.map((r) => <option key={r} value={r}>{t(`rtype.${r}`)}</option>)}</Select></Field>
            <Field label={t('lib.category')}><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">{t('common.all')}</option>
              {(cats.data || []).map((c) => <option key={c.id} value={c.id}>{lang === 'ar' ? c.name_ar : c.name_en}</option>)}</Select></Field>
          </div>)}
        <AsyncView state={state} empty={<Empty glyph="📚" title={t('lib.empty')}>{t('lib.empty_hint')}</Empty>}>
          {(rows) => (
            <div className="stack">{rows.map((r) => (
              <Card key={r.id} className="clickable">
                <div className="row between" style={{ cursor: 'pointer' }} onClick={() => nav(`/lawyer/library/${r.id}`)}>
                  <div className="grow"><h3 style={{ margin: 0 }}>{r.title}</h3>
                    <div className="small muted">{t(`rtype.${r.resource_type}`)}{r.law_name ? ` · ${r.law_name}` : ''}{r.article_number ? ` · ${t('lib.article')} ${r.article_number}` : ''}{catName(r.category_id) ? ` · ${catName(r.category_id)}` : ''}</div></div>
                  <div className="row"><span className={`badge ${r.is_official_source ? 'success' : 'neutral'}`}>{r.is_official_source ? t('lib.official') : t('lib.explanatory')}</span>
                    <StatusBadge status={r.verification_status} prefix="lib.vstatus" /></div>
                </div>
              </Card>))}</div>)}
        </AsyncView>
      </div>
    </>);
}

export function ResourceDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const nav = useNavigate();
  const toast = useToast(); const onError = useErrorToast();
  const { disclaimer } = usePublicSettings();
  const [report, setReport] = useState(false); const [reason, setReason] = useState('outdated'); const [details, setDetails] = useState('');
  const state = useAsync(async () => {
    const r = unwrap(await supabase.from('legal_resources').select('*').eq('id', id).maybeSingle());
    if (!r) return null;
    supabase.rpc('touch_resource_view', { p_resource: id }).then(() => {});
    const bm = unwrap(await supabase.from('resource_bookmarks').select('resource_id').eq('resource_id', id).maybeSingle());
    return { r, bookmarked: !!bm };
  }, [id]);
  const toggle = async (on) => {
    try {
      if (on) unwrap(await supabase.from('resource_bookmarks').delete().eq('resource_id', id));
      else unwrap(await supabase.from('resource_bookmarks').insert({ user_id: user.id, resource_id: id }));
      state.reload();
    } catch (e) { onError(e); }
  };
  const sendReport = async () => {
    try { unwrap(await supabase.from('resource_reports').insert({ resource_id: id, reporter_id: user.id, reason, details: details.trim() || null })); setReport(false); toast(t('lib.report_sent'), 'success'); }
    catch (e) { onError(e); }
  };
  return (
    <AsyncView state={state}>
      {(d) => {
        if (!d) return <Alert tone="warn">{t('common.not_found')}</Alert>;
        const { r } = d;
        return (
          <>
            <PageHead title={r.title} subtitle={t(`rtype.${r.resource_type}`)} actions={<>
              <Button size="sm" onClick={() => nav(-1)}>{t('common.back')}</Button>
              <Button size="sm" onClick={() => toggle(d.bookmarked)}>{d.bookmarked ? '★ ' + t('lib.bookmarked') : '☆ ' + t('lib.bookmark')}</Button>
              {r.file_path && <Button size="sm" variant="primary" onClick={() => openSigned('library', r.file_path, { download: r.file_name || true }).catch(onError)}>⬇ {t('common.download')}</Button>}
              <Button size="sm" variant="ghost" onClick={() => setReport(true)}>🚩 {t('lib.report')}</Button></>} />
            <div className="stack">
              <VerificationNotice r={r} />
              <Alert tone={r.is_official_source ? 'success' : 'info'} className="small">{r.is_official_source ? t('lib.official_note') : t('lib.explanatory_note')}</Alert>
              <Card title={t('common.details')}><KV items={[
                r.law_name && [t('lib.law_name'), r.law_name], r.article_number && [t('lib.article_no'), r.article_number], [t('lib.issuing'), r.issuing_authority],
                [t('lib.publication'), r.publication_date ? formatDate(`${r.publication_date}T12:00:00Z`, 'UTC', lang) : null], [t('lib.effective'), r.effective_date ? formatDate(`${r.effective_date}T12:00:00Z`, 'UTC', lang) : null],
                [t('lib.version'), r.version], [t('lib.source'), r.source_url ? <a key="s" href={r.source_url} target="_blank" rel="noopener noreferrer">{r.source || r.source_url}</a> : r.source],
                [t('lib.language'), t(`lang.${r.language}`)], [t('lib.last_verified'), r.last_verified_at ? formatDate(`${r.last_verified_at}T12:00:00Z`, 'UTC', lang) : t('lib.never_verified')],
                r.license_note && [t('lib.license'), r.license_note], r.tags?.length ? [t('lib.tags'), r.tags.map((x) => <span className="chip" key={x} style={{ marginInlineEnd: 4 }}>{x}</span>)] : null]} /></Card>
              {Array.isArray(r.amendment_history) && r.amendment_history.length > 0 && (
                <Card title={t('lib.amendments')}><div className="list">{r.amendment_history.map((a, i) => (
                  <div className="list-item" key={i}><span className="chip">{a.date || ''}</span><span className="grow">{a.note || a.description || ''}</span></div>))}</div></Card>)}
              {r.body_text && <Card title={t('lib.text')}><div dir={r.language === 'ar' ? 'rtl' : 'ltr'} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.9 }}>{r.body_text}</div></Card>}
              <Disclaimer text={disclaimer('library')} />
            </div>
            {report && (
              <Modal title={t('lib.report')} onClose={() => setReport(false)} actions={<><Button onClick={() => setReport(false)}>{t('common.cancel')}</Button><Button variant="primary" onClick={sendReport}>{t('common.send')}</Button></>}>
                <div className="stack">
                  <Field label={t('lib.report_reason')}><Select value={reason} onChange={(e) => setReason(e.target.value)}>{['outdated', 'incorrect', 'copyright', 'other'].map((x) => <option key={x} value={x}>{t(`lib.reason.${x}`)}</option>)}</Select></Field>
                  <Field label={t('lib.report_details')}><Textarea value={details} onChange={(e) => setDetails(e.target.value)} /></Field>
                </div>
              </Modal>)}
          </>);
      }}
    </AsyncView>);
}
