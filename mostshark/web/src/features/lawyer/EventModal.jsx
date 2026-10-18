import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { formatDateTime, utcIsoToZonedLocal, zonedLocalToUtcIso } from '../../lib/dates.js';
import { EDITABLE_KINDS, EVENT_KINDS, mapsLinks } from '../../lib/eventKinds.js';
import MapPicker from '../../components/MapPicker.jsx';
import { Alert, Button, Checkbox, ConfirmDialog, Field, Input, Modal, Select, StatusBadge, Textarea, useErrorToast, useToast } from '../../components/ui.jsx';

const PRESETS = [1440, 120, 30];

function HearingResult({ ev, tz, onClose, onDone }) {
  const { t } = useI18n();
  const onError = useErrorToast();
  const [outcome, setOutcome] = useState(ev.outcome || '');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      unwrap(await supabase.rpc('record_hearing_result', {
        p_event: ev.id, p_outcome: outcome.trim(), p_next_start: next ? zonedLocalToUtcIso(next, tz) : null, p_next_location: null,
      }));
      onDone();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('cal.record_result')} onClose={onClose} actions={<><Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" loading={busy} disabled={!outcome.trim()} onClick={save}>{t('common.save')}</Button></>}>
      <div className="stack">
        <Field label={t('cal.hearing_result')}><Textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} /></Field>
        <Field label={t('cal.next_hearing')} hint={t('cal.next_hearing_hint')}><Input className="input ltr" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export default function EventModal({ event, defaults = {}, onClose, onSaved }) {
  const { t, lang } = useI18n();
  const { user, tz } = useAuth();
  const toast = useToast();
  const onError = useErrorToast();
  const isNew = !event;
  const e0 = event || {};

  const lists = useAsync(async () => {
    const [cases, clients] = await Promise.all([
      supabase.from('cases').select('id,title,case_number').is('deleted_at', null).order('created_at', { ascending: false }).limit(300),
      supabase.from('clients').select('id,full_name').is('deleted_at', null).order('full_name').limit(500),
    ]);
    return { cases: unwrap(cases), clients: unwrap(clients) };
  }, []);

  const initialOffsets = e0.reminder_offsets_min ?? PRESETS;
  const [f, setF] = useState({
    kind: e0.kind || defaults.kind || 'appointment',
    title: e0.title || '', description: e0.description || '',
    case_id: e0.case_id || defaults.case_id || '', client_id: e0.client_id || '',
    start: e0.starts_at ? utcIsoToZonedLocal(e0.starts_at, tz) : (defaults.start || ''),
    end: e0.ends_at ? utcIsoToZonedLocal(e0.ends_at, tz) : '',
    location_text: e0.location_text || '', latitude: e0.latitude ?? null, longitude: e0.longitude ?? null, nav_url: e0.nav_url || '',
    presets: PRESETS.filter((p) => initialOffsets.includes(p)),
    custom: initialOffsets.filter((o) => !PRESETS.includes(o)).join(','),
    source: e0.source || 'user_entered',
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [showMap, setShowMap] = useState(f.latitude != null);
  const [result, setResult] = useState(false);
  const set = (k) => (ev) => setF({ ...f, [k]: ev.target.value });
  const cancelled = e0.status === 'cancelled';

  const buildRow = () => {
    const custom = f.custom.split(/[,،\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 60 * 24 * 60);
    return {
      kind: f.kind, title: f.title.trim(), description: f.description.trim() || null,
      case_id: f.case_id || null, client_id: f.client_id || null,
      starts_at: zonedLocalToUtcIso(f.start, tz), ends_at: f.end ? zonedLocalToUtcIso(f.end, tz) : null,
      location_text: f.location_text.trim() || null, latitude: f.latitude, longitude: f.longitude,
      nav_url: f.nav_url.trim() || null,
      reminder_offsets_min: [...new Set([...f.presets, ...custom])].sort((a, b) => b - a),
    };
  };

  const persist = async (row) => {
    setBusy(true);
    try {
      if (isNew) unwrap(await supabase.from('calendar_events').insert({ ...row, lawyer_id: user.id }));
      else unwrap(await supabase.from('calendar_events').update(row).eq('id', e0.id));
      toast(t('common.saved'), 'success');
      onSaved();
    } catch (err) { onError(err); } finally { setBusy(false); }
  };

  const save = async (skipConflicts = false) => {
    const er = {};
    if (f.title.trim().length < 2) er.title = t('val.required');
    if (!f.start) er.start = t('val.required');
    if (f.start && f.end && f.end < f.start) er.end = t('val.end_after_start');
    if (f.nav_url && !/^https?:\/\//i.test(f.nav_url.trim())) er.nav_url = t('val.url');
    setErrors(er);
    if (Object.keys(er).length) return;
    const row = buildRow();
    if (!skipConflicts) {
      try {
        const found = unwrap(await supabase.rpc('find_event_conflicts', { p_start: row.starts_at, p_end: row.ends_at, p_exclude: isNew ? null : e0.id }));
        if (found.length) { setConflicts({ list: found, row }); return; }
      } catch (err) { onError(err); return; }
    }
    persist(row);
  };

  const setStatus = async (status) => {
    setBusy(true);
    try { unwrap(await supabase.from('calendar_events').update({ status }).eq('id', e0.id)); onSaved(); }
    catch (err) { onError(err); } finally { setBusy(false); }
  };
  const softDelete = async () => {
    try { unwrap(await supabase.from('calendar_events').update({ deleted_at: new Date().toISOString() }).eq('id', e0.id)); onSaved(); }
    catch (err) { onError(err); }
  };
  const useMyLocation = () => {
    if (!navigator.geolocation) return toast(t('cal.geo_unsupported'), 'error');
    navigator.geolocation.getCurrentPosition(
      (p) => setF((x) => ({ ...x, latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)) })),
      () => toast(t('cal.geo_denied'), 'error'), { maximumAge: 60000, timeout: 10000 });
  };
  const links = mapsLinks(f.latitude, f.longitude);

  return (
    <Modal title={isNew ? t('cal.new_event') : t('cal.edit_event')} onClose={onClose} wide actions={<>
      {!isNew && <Button variant="danger" size="sm" onClick={() => setConfirm('delete')}>{t('common.delete')}</Button>}
      {!isNew && !cancelled && e0.status !== 'completed' && <Button size="sm" onClick={() => setConfirm('cancel')}>{t('cal.cancel_event')}</Button>}
      {!isNew && e0.kind === 'hearing' && <Button size="sm" onClick={() => setResult(true)}>{t('cal.record_result')}</Button>}
      {!isNew && !cancelled && e0.status === 'scheduled' && e0.kind !== 'hearing' && <Button size="sm" onClick={() => setStatus('completed')}>{t('cal.mark_done')}</Button>}
      {cancelled && <Button size="sm" onClick={() => setStatus('scheduled')}>{t('cal.restore')}</Button>}
      <Button onClick={onClose}>{t('common.close')}</Button>
      <Button variant="primary" loading={busy} onClick={() => save(false)}>{t('common.save')}</Button></>}>
      <div className="stack">
        {!isNew && <div className="row"><StatusBadge status={e0.status} prefix="evstatus" />
          {e0.kind === 'hearing' && <span className={`badge ${e0.source === 'verified_external' ? 'success' : 'warn'}`}>{t(`cal.source.${e0.source}`)}</span>}</div>}
        {f.kind === 'hearing' && <Alert tone="warn" className="small">{t('cal.hearing_unverified')}</Alert>}
        <div className="grid cols-2">
          <Field label={t('cal.kind')}>
            <Select value={f.kind} onChange={set('kind')}>{EDITABLE_KINDS.map((k) => <option key={k} value={k}>{EVENT_KINDS[k].icon} {t(`kind.${k}`)}</option>)}</Select>
          </Field>
          <Field label={t('cal.title')} error={errors.title}><Input value={f.title} onChange={set('title')} maxLength={200} /></Field>
          <Field label={t('cal.start')} error={errors.start} hint={`${t('cal.tz')}: ${tz}`}><Input className="input ltr" type="datetime-local" value={f.start} onChange={set('start')} /></Field>
          <Field label={t('cal.end')} error={errors.end}><Input className="input ltr" type="datetime-local" value={f.end} onChange={set('end')} /></Field>
          <Field label={t('cal.case')}>
            <Select value={f.case_id} onChange={set('case_id')}><option value="">—</option>
              {(lists.data?.cases || []).map((c) => <option key={c.id} value={c.id}>{c.case_number} — {c.title}</option>)}</Select>
          </Field>
          <Field label={t('cal.client')}>
            <Select value={f.client_id} onChange={set('client_id')}><option value="">—</option>
              {(lists.data?.clients || []).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</Select>
          </Field>
        </div>
        <Field label={t('cal.description')}><Textarea value={f.description} onChange={set('description')} /></Field>

        <fieldset className="card flat stack" style={{ margin: 0 }}>
          <legend className="small muted">{t('cal.location')}</legend>
          <Field label={t('cal.address')}><Input value={f.location_text} onChange={set('location_text')} /></Field>
          <div className="row">
            <Button size="sm" type="button" onClick={() => setShowMap((s) => !s)}>🗺️ {showMap ? t('cal.hide_map') : t('cal.pick_on_map')}</Button>
            <Button size="sm" type="button" onClick={useMyLocation}>📍 {t('cal.use_my_location')}</Button>
            {f.latitude != null && <Button size="sm" type="button" variant="ghost" onClick={() => setF({ ...f, latitude: null, longitude: null })}>{t('cal.clear_pin')}</Button>}
          </div>
          {showMap && <MapPicker lat={f.latitude} lng={f.longitude} onPick={(la, lo) => setF((x) => ({ ...x, latitude: la, longitude: lo }))} />}
          {links && <div className="row small"><span className="ltr muted">{f.latitude}, {f.longitude}</span>
            <a href={links.google} target="_blank" rel="noopener noreferrer">Google Maps</a><a href={links.osm} target="_blank" rel="noopener noreferrer">OpenStreetMap</a></div>}
          <Field label={t('cal.nav_link')} error={errors.nav_url}><Input className="input ltr" value={f.nav_url} onChange={set('nav_url')} placeholder="https://" /></Field>
          {f.nav_url && /^https?:\/\//i.test(f.nav_url) && <a className="small" href={f.nav_url} target="_blank" rel="noopener noreferrer">{t('cal.open_navigation')}</a>}
        </fieldset>

        <fieldset className="card flat stack" style={{ margin: 0 }}>
          <legend className="small muted">{t('cal.reminders')}</legend>
          <div className="row">
            {PRESETS.map((p) => (
              <Checkbox key={p} label={t(`cal.rem.${p}`)} checked={f.presets.includes(p)}
                onChange={() => setF({ ...f, presets: f.presets.includes(p) ? f.presets.filter((x) => x !== p) : [...f.presets, p] })} />))}
          </div>
          <Field label={t('cal.custom_reminder')} hint={t('cal.custom_reminder_hint')}><Input className="input ltr" value={f.custom} onChange={set('custom')} placeholder="45, 600" /></Field>
        </fieldset>
        {e0.outcome && <Alert tone="info"><strong>{t('cal.hearing_result')}:</strong> {e0.outcome}</Alert>}
      </div>

      {conflicts && (
        <Modal title={t('cal.conflict_title')} onClose={() => setConflicts(null)} actions={<>
          <Button onClick={() => setConflicts(null)}>{t('common.back')}</Button>
          <Button variant="primary" onClick={() => { const row = conflicts.row; setConflicts(null); persist(row); }}>{t('cal.save_anyway')}</Button></>}>
          <Alert tone="warn">{t('cal.conflict_msg')}</Alert>
          <div className="list" style={{ marginTop: 8 }}>{conflicts.list.map((c) => (
            <div key={c.id} className="list-item"><span>{EVENT_KINDS[c.kind]?.icon}</span><strong className="grow">{c.title}</strong>
              <span className="small muted">{formatDateTime(c.starts_at, tz, lang)}</span></div>))}</div>
        </Modal>)}
      {confirm === 'cancel' && <ConfirmDialog title={t('cal.cancel_event')} message={t('cal.cancel_msg')} onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await setStatus('cancelled'); }} />}
      {confirm === 'delete' && <ConfirmDialog title={t('common.delete')} message={t('cal.delete_msg')} danger onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await softDelete(); }} />}
      {result && <HearingResult ev={e0} tz={tz} onClose={() => setResult(false)} onDone={() => { setResult(false); onSaved(); }} />}
    </Modal>
  );
}
