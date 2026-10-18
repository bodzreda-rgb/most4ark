import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced } from '../../lib/hooks.js';
import { AsyncView, Card, Checkbox, Empty, Field, Input, PageHead, Select, Alert } from '../../components/ui.jsx';

/** Privacy-preserving directory: reads only the whitelisted public_lawyer_directory view. */
export default function Directory() {
  const { t, lang } = useI18n();
  const [f, setF] = useState({ spec: '', city: '', minExp: '', available: false });
  const dcity = useDebounced(f.city);
  const specs = useAsync(async () => unwrap(await supabase.from('specializations').select('*').eq('is_active', true).order('sort_order')), []);
  const state = useAsync(async () => {
    let q = supabase.from('public_lawyer_directory').select('*').order('years_experience', { ascending: false, nullsFirst: false }).limit(100);
    if (f.spec) q = q.contains('specialization_ids', [Number(f.spec)]);
    if (dcity.trim()) q = q.or(`city.ilike.%${dcity.trim().replace(/[,()%*]/g, ' ')}%`);
    if (f.minExp !== '' && Number(f.minExp) >= 0) q = q.gte('years_experience', Number(f.minExp));
    if (f.available) q = q.eq('accepts_consultations', true);
    return unwrap(await q);
  }, [f.spec, dcity, f.minExp, f.available]);
  const specName = (id) => { const s = (specs.data || []).find((x) => x.id === id); return s ? (lang === 'ar' ? s.name_ar : s.name_en) : ''; };
  return (
    <>
      <PageHead title={t('nav.directory')} subtitle={t('dir.subtitle')} />
      <Alert tone="info" className="small">{t('dir.privacy')}</Alert>
      <div className="card flat grid cols-4" style={{ margin: '16px 0' }}>
        <Field label={t('lawyer.specializations')}><Select value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })}><option value="">{t('common.all')}</option>
          {(specs.data || []).map((s) => <option key={s.id} value={s.id}>{lang === 'ar' ? s.name_ar : s.name_en}</option>)}</Select></Field>
        <Field label={t('dir.location')}><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label={t('dir.min_experience')}><Input className="input ltr" type="number" min="0" value={f.minExp} onChange={(e) => setF({ ...f, minExp: e.target.value })} /></Field>
        <Field label=" "><Checkbox label={t('dir.available_only')} checked={f.available} onChange={(e) => setF({ ...f, available: e.target.checked })} /></Field>
      </div>
      <AsyncView state={state} empty={<Empty glyph="🧭" title={t('dir.empty')} />}>
        {(rows) => (
          <div className="grid cols-3">{rows.map((l) => (
            <Card key={l.public_alias}>
              <div className="row between"><h3 className="ltr" style={{ margin: 0 }}>{l.public_alias}</h3><span className="badge success">{t('dir.verified')}</span></div>
              <p className="small muted">{[l.city, ...(l.working_locations || [])].filter(Boolean).join(' · ')}</p>
              <div className="row" style={{ marginBottom: 8 }}>{(l.specialization_ids || []).map((id) => <span key={id} className="chip">{specName(id)}</span>)}</div>
              <p className="small">{l.bio || ''}</p>
              <div className="row small muted"><span>{t('dir.experience')}: {l.years_experience ?? '—'}</span>
                {l.accepts_consultations && <span className="badge info">{t('dir.accepts')}</span>}</div>
              {l.availability_note && <p className="small muted" style={{ margin: '6px 0 0' }}>{l.availability_note}</p>}
            </Card>))}</div>)}
      </AsyncView>
    </>);
}
