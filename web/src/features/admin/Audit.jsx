import { Fragment, useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced, safeTerm } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { downloadCsv, toCsv } from '../../lib/csv.js';
import { AsyncView, Button, Empty, PageHead, SearchBox, Select, StatusBadge } from '../../components/ui.jsx';

export default function AuditLog() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [result, setResult] = useState('');
  const [open, setOpen] = useState(null);
  const state = useAsync(async () => {
    let query = supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(300);
    if (result) query = query.eq('result', result);
    const term = safeTerm(dq);
    if (term) query = query.ilike('action', `%${term}%`);
    return unwrap(await query);
  }, [dq, result]);
  const exportCsv = (rows) => downloadCsv('audit-log.csv', toCsv(rows.map((r) => ({ ...r, metadata: JSON.stringify(r.metadata) })),
    ['created_at', 'actor_id', 'action', 'entity_type', 'entity_id', 'result', 'metadata'].map((k) => ({ key: k, label: k }))));
  return (
    <>
      <PageHead title={t('nav.audit')} subtitle={t('admin.audit_sub')} actions={state.data?.length > 0 && <Button size="sm" onClick={() => exportCsv(state.data)}>{t('common.export_csv')}</Button>} />
      <div className="row" style={{ marginBottom: 16 }}>
        <SearchBox value={q} onChange={setQ} placeholder={t('admin.audit_search')} />
        <Select style={{ maxWidth: 180 }} value={result} onChange={(e) => setResult(e.target.value)} aria-label={t('audit.result')}>
          <option value="">{t('common.all')}</option>{['success', 'denied', 'error'].map((x) => <option key={x} value={x}>{t(`audit.result.${x}`)}</option>)}</Select>
      </div>
      <AsyncView state={state} empty={<Empty glyph="🧾" title={t('admin.no_activity')} />}>
        {(rows) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('audit.time')}</th><th>{t('audit.action')}</th><th>{t('audit.entity')}</th><th>{t('audit.result')}</th><th /></tr></thead>
            <tbody>{rows.map((a) => (
              <Fragment key={a.id}>
                <tr><td className="nowrap">{formatDateTime(a.created_at, tz, lang)}</td><td className="ltr">{a.action}</td>
                  <td className="ltr small">{a.entity_type}{a.entity_id ? `:${String(a.entity_id).slice(0, 8)}` : ''}</td>
                  <td><StatusBadge status={a.result} prefix="audit.result" /></td>
                  <td><Button size="sm" variant="ghost" onClick={() => setOpen(open === a.id ? null : a.id)}>{t('common.details')}</Button></td></tr>
                {open === a.id && <tr><td colSpan={5}><pre className="ltr small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify({ actor: a.actor_id, ...a.metadata }, null, 2)}</pre></td></tr>}
              </Fragment>))}</tbody></table></div>)}
      </AsyncView>
    </>);
}
