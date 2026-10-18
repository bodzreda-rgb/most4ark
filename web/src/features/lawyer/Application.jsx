import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { MIME_IMAGES_PDF, openSigned, uploadFile, validateFile } from '../../lib/storage.js';
import { Alert, AsyncView, Button, Card, Checkbox, Field, Input, PageHead, StatusBadge, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';
import { Navigate } from 'react-router-dom';

const BUCKET = 'lawyer-verification';
const CONTACT = ['in_app', 'phone', 'email', 'whatsapp'];
const LANGS = ['ar', 'en', 'fr'];

/** Shared professional-info form (registration + later edits). */
export function LawyerForm({ initial, specs, selectedSpecs, onChangeSpecs, identityLocked, onSave, saving }) {
  const { t, lang } = useI18n();
  const [f, setF] = useState({
    full_legal_name: initial.full_legal_name || '', bar_membership_number: initial.bar_membership_number || '', bar_branch: initial.bar_branch || '',
    city: initial.city || '', working_locations: (initial.working_locations || []).join('، '), years_experience: initial.years_experience ?? '',
    bio: initial.bio || '', languages: initial.languages || ['ar'], contact_preferences: initial.contact_preferences || ['in_app'],
    accepts_consultations: !!initial.accepts_consultations, availability_note: initial.availability_note || '', show_in_directory: initial.show_in_directory ?? true,
  });
  const [errors, setErrors] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const toggle = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });

  const submit = (e) => {
    e.preventDefault();
    const er = {};
    if (!identityLocked) {
      if (f.full_legal_name.trim().length < 6) er.full_legal_name = t('val.legal_name');
      if (!f.bar_membership_number.trim()) er.bar_membership_number = t('val.required');
    }
    if (!f.city.trim()) er.city = t('val.required');
    const y = Number(f.years_experience);
    if (f.years_experience === '' || !Number.isInteger(y) || y < 0 || y > 70) er.years_experience = t('val.years');
    if (selectedSpecs.length === 0) er.specs = t('val.specialization');
    setErrors(er);
    if (Object.keys(er).length) return;
    const row = {
      city: f.city.trim(), working_locations: f.working_locations.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean),
      years_experience: y, bio: f.bio.trim() || null, languages: f.languages, contact_preferences: f.contact_preferences,
      accepts_consultations: f.accepts_consultations, availability_note: f.availability_note.trim() || null, show_in_directory: f.show_in_directory,
    };
    if (!identityLocked) Object.assign(row, { full_legal_name: f.full_legal_name.trim(), bar_membership_number: f.bar_membership_number.trim(), bar_branch: f.bar_branch.trim() || null });
    onSave(row);
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="grid cols-2">
        <Field label={t('lawyer.legal_name')} error={errors.full_legal_name} hint={identityLocked ? t('lawyer.identity_locked') : t('lawyer.legal_name_hint')}>
          <Input value={f.full_legal_name} onChange={set('full_legal_name')} disabled={identityLocked} />
        </Field>
        <Field label={t('lawyer.bar_number')} error={errors.bar_membership_number}>
          <Input className="input ltr" value={f.bar_membership_number} onChange={set('bar_membership_number')} disabled={identityLocked} />
        </Field>
        <Field label={t('lawyer.bar_branch')}><Input value={f.bar_branch} onChange={set('bar_branch')} disabled={identityLocked} /></Field>
        <Field label={t('lawyer.city')} error={errors.city}><Input value={f.city} onChange={set('city')} /></Field>
        <Field label={t('lawyer.working_locations')} hint={t('lawyer.working_locations_hint')}><Input value={f.working_locations} onChange={set('working_locations')} /></Field>
        <Field label={t('lawyer.years')} error={errors.years_experience}><Input className="input ltr" type="number" min="0" max="70" value={f.years_experience} onChange={set('years_experience')} /></Field>
      </div>
      <Field label={t('lawyer.specializations')} error={errors.specs}>
        <div className="row">{specs.map((s) => (
          <label key={s.id} className="chip" style={{ cursor: 'pointer', background: selectedSpecs.includes(s.id) ? 'var(--accent-soft)' : undefined, border: selectedSpecs.includes(s.id) ? '1px solid var(--accent)' : '1px solid transparent' }}>
            <input type="checkbox" checked={selectedSpecs.includes(s.id)} onChange={() => onChangeSpecs(s.id)} style={{ marginInlineEnd: 6 }} />
            {lang === 'ar' ? s.name_ar : s.name_en}
          </label>))}</div>
      </Field>
      <Field label={t('lawyer.bio')} hint={t('lawyer.bio_hint')}><Textarea value={f.bio} onChange={set('bio')} maxLength={2000} /></Field>
      <div className="grid cols-2">
        <Field label={t('lawyer.languages')}><div className="row">{LANGS.map((l) => (
          <label key={l} className="chip"><input type="checkbox" checked={f.languages.includes(l)} onChange={() => toggle('languages', l)} style={{ marginInlineEnd: 6 }} />{t(`lang.${l}`)}</label>))}</div></Field>
        <Field label={t('lawyer.contact_prefs')}><div className="row">{CONTACT.map((c) => (
          <label key={c} className="chip"><input type="checkbox" checked={f.contact_preferences.includes(c)} onChange={() => toggle('contact_preferences', c)} style={{ marginInlineEnd: 6 }} />{t(`contact.${c}`)}</label>))}</div></Field>
      </div>
      <Checkbox checked={f.accepts_consultations} onChange={set('accepts_consultations')} label={t('lawyer.accepts_consultations')} />
      <Checkbox checked={f.show_in_directory} onChange={set('show_in_directory')} label={t('lawyer.show_in_directory')} />
      {f.accepts_consultations && <Field label={t('lawyer.availability_note')}><Input value={f.availability_note} onChange={set('availability_note')} /></Field>}
      <div><Button variant="primary" type="submit" loading={saving}>{t('common.save')}</Button></div>
    </form>
  );
}

const STEP_STATES = ['draft', 'submitted', 'under_review', 'approved'];

export default function Application() {
  const { t, lang } = useI18n();
  const { user, lawyer, refresh, tz, isApprovedLawyer } = useAuth();
  const toast = useToast();
  const onError = useErrorToast();
  const cardRef = useRef(null); const suppRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const data = useAsync(async () => {
    const [specs, mine, docs, events] = await Promise.all([
      supabase.from('specializations').select('*').eq('is_active', true).order('sort_order'),
      supabase.from('lawyer_specializations').select('specialization_id').eq('lawyer_id', user.id),
      supabase.from('application_documents').select('*').eq('lawyer_id', user.id).is('deleted_at', null).order('created_at'),
      supabase.from('verification_events').select('*').eq('lawyer_id', user.id).order('created_at', { ascending: false }),
    ]);
    return { specs: unwrap(specs), mine: unwrap(mine).map((r) => r.specialization_id), docs: unwrap(docs), events: unwrap(events) };
  }, [user.id]);
  const [selected, setSelected] = useState(null);

  if (isApprovedLawyer) return <Navigate to="/lawyer" replace />;
  const status = lawyer?.verification_status || 'draft';
  const editable = status === 'draft' || status === 'rejected';

  return (
    <AsyncView state={data}>
      {(d) => {
        const sel = selected ?? d.mine;
        const toggleSpec = async (id) => {
          const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
          setSelected(next);
        };
        const saveAll = async (row) => {
          setSaving(true);
          try {
            const { full_legal_name, bar_membership_number, bar_branch, ...professional } = row;
            if (full_legal_name !== undefined) {
              unwrap(await supabase.from('lawyer_identities').update({ full_legal_name, bar_membership_number, bar_branch }).eq('user_id', user.id));
            }
            unwrap(await supabase.from('lawyer_profiles').update(professional).eq('user_id', user.id));
            const add = sel.filter((x) => !d.mine.includes(x));
            const del = d.mine.filter((x) => !sel.includes(x));
            if (add.length) unwrap(await supabase.from('lawyer_specializations').insert(add.map((id) => ({ lawyer_id: user.id, specialization_id: id }))));
            if (del.length) unwrap(await supabase.from('lawyer_specializations').delete().eq('lawyer_id', user.id).in('specialization_id', del));
            await refresh(); data.reload(); setSelected(null);
            toast(t('common.saved'), 'success');
          } catch (e) { onError(e); } finally { setSaving(false); }
        };
        const upload = async (file, docType) => {
          const bad = validateFile(file, { maxMb: 10, mimes: MIME_IMAGES_PDF });
          if (bad) return toast(t(`err.${bad}`, { mb: 10 }), 'error');
          try {
            const up = await uploadFile(BUCKET, user.id, file);
            unwrap(await supabase.from('application_documents').insert({
              lawyer_id: user.id, doc_type: docType, storage_path: up.path, file_name: up.file_name, mime_type: up.mime_type, size_bytes: up.size_bytes,
            }));
            data.reload();
          } catch (e) { onError(e); }
        };
        const removeDoc = async (doc) => {
          try {
            await supabase.storage.from(BUCKET).remove([doc.storage_path]);
            unwrap(await supabase.from('application_documents').update({ deleted_at: new Date().toISOString() }).eq('id', doc.id));
            data.reload();
          } catch (e) { onError(e); }
        };
        const submitApp = async () => {
          setSubmitting(true);
          try { unwrap(await supabase.rpc('submit_lawyer_application')); await refresh(); data.reload(); toast(t('lawyer.submitted_ok'), 'success'); }
          catch (e) { onError(e); } finally { setSubmitting(false); }
        };
        const hasCard = d.docs.some((x) => x.doc_type === 'bar_card');
        const stepIdx = STEP_STATES.indexOf(status === 'rejected' ? 'draft' : status === 'suspended' ? 'approved' : status);

        return (
          <>
            <PageHead title={t('lawyer.application_title')} subtitle={t('lawyer.application_subtitle')} actions={<StatusBadge status={status} prefix="vstatus" />} />
            <div className="row" style={{ marginBottom: 16 }} aria-label={t('lawyer.progress')}>
              {STEP_STATES.map((s, i) => <span key={s} className={`badge ${i <= stepIdx ? 'success' : 'neutral'}`}>{i + 1}. {t(`vstatus.${s}`)}</span>)}
            </div>
            {status === 'rejected' && <Alert tone="danger"><strong>{t('lawyer.rejected_title')}</strong><br />{lawyer.rejection_reason}<br /><span className="small">{t('lawyer.rejected_hint')}</span></Alert>}
            {(status === 'submitted' || status === 'under_review') && <Alert tone="info">{t('lawyer.wait_review')}</Alert>}
            {status === 'suspended' && <Alert tone="danger">{t('lawyer.suspended_note')}</Alert>}
            <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
              <Card title={t('lawyer.professional_info')}>
                <LawyerForm initial={lawyer || {}} specs={d.specs} selectedSpecs={sel} onChangeSpecs={toggleSpec} identityLocked={!editable} onSave={saveAll} saving={saving} />
              </Card>
              <div className="stack">
                <Card title={t('lawyer.documents')}>
                  <Alert tone="info" className="small">{t('lawyer.docs_private')}</Alert>
                  <div className="list" style={{ marginTop: 8 }}>
                    {d.docs.map((doc) => (
                      <div className="list-item" key={doc.id}>
                        <span>{doc.doc_type === 'bar_card' ? '🪪' : '📎'}</span>
                        <div className="grow"><strong>{t(`lawyer.doc.${doc.doc_type}`)}</strong><div className="small muted">{doc.file_name}</div></div>
                        <Button size="sm" onClick={() => openSigned(BUCKET, doc.storage_path).catch(onError)}>{t('common.open')}</Button>
                        {editable && <Button size="sm" variant="danger" onClick={() => removeDoc(doc)}>{t('common.remove')}</Button>}
                      </div>))}
                    {d.docs.length === 0 && <p className="muted small">{t('lawyer.no_docs')}</p>}
                  </div>
                  {editable && (
                    <div className="row" style={{ marginTop: 12 }}>
                      <input ref={cardRef} hidden type="file" accept={MIME_IMAGES_PDF.join(',')} onChange={(e) => { if (e.target.files[0]) upload(e.target.files[0], 'bar_card'); e.target.value = ''; }} />
                      <input ref={suppRef} hidden type="file" accept={MIME_IMAGES_PDF.join(',')} onChange={(e) => { if (e.target.files[0]) upload(e.target.files[0], 'supporting'); e.target.value = ''; }} />
                      <Button variant="accent" onClick={() => cardRef.current.click()}>{hasCard ? t('lawyer.replace_card') : t('lawyer.upload_card')}</Button>
                      <Button onClick={() => suppRef.current.click()}>{t('lawyer.upload_supporting')}</Button>
                    </div>)}
                </Card>
                {editable && (
                  <Card title={t('lawyer.submit_title')}>
                    <p className="small muted">{t('lawyer.submit_hint')}</p>
                    <Button variant="primary" onClick={submitApp} loading={submitting}>{status === 'rejected' ? t('lawyer.resubmit') : t('lawyer.submit')}</Button>
                  </Card>)}
                <Card title={t('lawyer.history')}>
                  <div className="list">{d.events.map((ev) => (
                    <div className="list-item" key={ev.id}><StatusBadge status={ev.to_status} prefix="vstatus" /><span className="grow small muted">{ev.reason || ''}</span>
                      <span className="small muted">{formatDateTime(ev.created_at, tz, lang)}</span></div>))}
                    {d.events.length === 0 && <p className="muted small">—</p>}</div>
                </Card>
              </div>
            </div>
          </>
        );
      }}
    </AsyncView>
  );
}
