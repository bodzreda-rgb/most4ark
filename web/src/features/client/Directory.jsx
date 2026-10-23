import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced } from '../../lib/hooks.js';
import { Avatar } from '../../components/Layout.jsx';
import { AsyncView, Button, Checkbox, Empty, Field, Input, Modal, PageHead, Select } from '../../components/ui.jsx';

const short = (s, n = 140) => (s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s || '');

function LawyerModal({ l, specName, onClose, isClient }) {
  const { t } = useI18n();
  return (
    <Modal title={l.full_name || l.public_alias} onClose={onClose} actions={<>
      <Button onClick={onClose}>{t('common.close')}</Button>
      {isClient && <Link className="btn btn-primary" to="/client/new">⚖️ {t('dir.ask_lawyer')}</Link>}</>}>
      <div className="lawyer-modal-head">
        <Avatar name={l.full_name} src={l.avatar_url} size={88} />
        <div>
          {l.headline && <p className="lawyer-headline">{l.headline}</p>}
          <p className="small muted">{[l.city, ...(l.working_locations || [])].filter(Boolean).join(' · ')}</p>
          <span className="badge success">✓ {t('dir.verified')}</span>
        </div>
      </div>
      <div className="row" style={{ margin: '12px 0' }}>{(l.specialization_ids || []).map((id) => <span key={id} className="chip">{specName(id)}</span>)}</div>
      {l.bio && <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{l.bio}</p>}
      <p className="small muted">{t('dir.experience')}: {l.years_experience ?? '—'} {t('dir.years')}</p>
      {l.availability_note && <p className="small muted">{l.availability_note}</p>}
    </Modal>);
}

/** Lawyer directory for clients: photo, a short brief and specializations. Reads only the whitelisted view. */
export default function Directory({ embedded = false }) {
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const isClient = profile?.account_type === 'client';
  const [f, setF] = useState({ spec: '', city: '', minExp: '', available: false });
  const [open, setOpen] = useState(null);
  const dcity = useDebounced(f.city);
  const specs = useAsync(async () => unwrap(await supabase.from('specializations').select('*').eq('is_active', true).order('sort_order')), []);
  const state = useAsync(async () => {
    let q = supabase.from('public_lawyer_directory').select('*')
      .order('featured', { ascending: false }).order('years_experience', { ascending: false, nullsFirst: false }).limit(100);
    if (f.spec) q = q.contains('specialization_ids', [Number(f.spec)]);
    if (dcity.trim()) q = q.or(`city.ilike.%${dcity.trim().replace(/[,()%*]/g, ' ')}%`);
    if (f.minExp !== '' && Number(f.minExp) >= 0) q = q.gte('years_experience', Number(f.minExp));
    if (f.available) q = q.eq('accepts_consultations', true);
    return unwrap(await q);
  }, [f.spec, dcity, f.minExp, f.available]);
  const specName = (id) => { const s = (specs.data || []).find((x) => x.id === id); return s ? (lang === 'ar' ? s.name_ar : s.name_en) : ''; };
  return (
    <>
      {!embedded && <PageHead title={t('nav.directory')} subtitle={t('dir.subtitle_client')} />}
      <div className="card flat grid cols-4" style={{ margin: '16px 0' }}>
        <Field label={t('lawyer.specializations')}><Select value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })}><option value="">{t('common.all')}</option>
          {(specs.data || []).map((s) => <option key={s.id} value={s.id}>{lang === 'ar' ? s.name_ar : s.name_en}</option>)}</Select></Field>
        <Field label={t('dir.location')}><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label={t('dir.min_experience')}><Input className="input ltr" type="number" min="0" value={f.minExp} onChange={(e) => setF({ ...f, minExp: e.target.value })} /></Field>
        <Field label=" "><Checkbox label={t('dir.available_only')} checked={f.available} onChange={(e) => setF({ ...f, available: e.target.checked })} /></Field>
      </div>
      <AsyncView state={state} empty={<Empty glyph="🧭" title={t('dir.empty')} />}>
        {(rows) => (
          <div className="lawyer-grid">{rows.map((l) => (
            <article key={l.public_alias} className="lawyer-card">
              <button type="button" className="lawyer-card-body" onClick={() => setOpen(l)} aria-label={`${l.full_name || l.public_alias} — ${t('dir.view_profile')}`}>
                <Avatar name={l.full_name} src={l.avatar_url} size={76} />
                <h3>{l.full_name || l.public_alias}</h3>
                {l.full_name && <span className="small muted ltr">{l.public_alias}</span>}
                {l.headline && <p className="lawyer-headline">{l.headline}</p>}
                <p className="small muted">{[l.city, l.years_experience != null && `${l.years_experience} ${t('dir.years')}`].filter(Boolean).join(' · ')}</p>
                <div className="row center">{(l.specialization_ids || []).slice(0, 3).map((id) => <span key={id} className="chip">{specName(id)}</span>)}</div>
                {l.bio && <p className="small lawyer-brief">{short(l.bio)}</p>}
              </button>
              <div className="lawyer-card-foot">
                {l.featured && <span className="badge warn">⭐ {t('dir.featured')}</span>}
                <span className="badge success">✓ {t('dir.verified')}</span>
                {l.accepts_consultations && <span className="badge info">{t('dir.accepts')}</span>}
              </div>
            </article>))}</div>)}
      </AsyncView>
      {open && <LawyerModal l={open} specName={specName} isClient={isClient} onClose={() => setOpen(null)} />}
    </>);
}
