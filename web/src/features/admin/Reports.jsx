import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { todayKey, addDays } from '../../lib/dates.js';
import { downloadCsv, toCsv } from '../../lib/csv.js';
import { AsyncView, Button, Card, Field, Input, PageHead, Stat } from '../../components/ui.jsx';

export default function Reports() {
  const { t } = useI18n();
  const [from, setFrom] = useState(addDays(todayKey(), -29));
  const [to, setTo] = useState(todayKey());
  const state = useAsync(async () => unwrap(await supabase.rpc('admin_report_summary', { p_from: from, p_to: to })), [from, to]);
  const exportAll = (r) => {
    const rows = [
      ...Object.entries(r.consultations_by_status).map(([k, v]) => ({ section: 'consultations_by_status', key: k, value: v })),
      ...r.consultations_by_category.map((x) => ({ section: 'consultations_by_category', key: x.category, value: x.count })),
      ...r.signups_by_month.map((x) => ({ section: 'signups_by_month', key: x.month, value: x.count })),
      ...Object.entries(r.lawyers_by_status).map(([k, v]) => ({ section: 'lawyers_by_status', key: k, value: v })),
    ];
    downloadCsv(`report-${from}_${to}.csv`, toCsv(rows, ['section', 'key', 'value'].map((k) => ({ key: k, label: k }))));
  };
  const Table = ({ rows }) => (rows.length === 0 ? <p className="muted small">—</p> :
    <table className="table"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td className="ltr" style={{ textAlign: 'end' }}>{v}</td></tr>)}</tbody></table>);
  return (
    <>
      <PageHead title={t('nav.reports')} actions={state.data && <Button size="sm" onClick={() => exportAll(state.data)}>{t('common.export_csv')}</Button>} />
      <div className="row" style={{ marginBottom: 16 }}>
        <Field label={t('common.from')}><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label={t('common.to')}><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <AsyncView state={state}>
        {(r) => (
          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            <Card title={t('report.cons_by_status')}><Table rows={Object.entries(r.consultations_by_status).map(([k, v]) => [t(`cons.status.${k}`), v])} /></Card>
            <Card title={t('report.cons_by_category')}><Table rows={r.consultations_by_category.map((x) => [x.category, x.count])} /></Card>
            <Card title={t('report.signups')}><Table rows={r.signups_by_month.map((x) => [x.month, x.count])} /></Card>
            <Card title={t('report.lawyers_by_status')}><Table rows={Object.entries(r.lawyers_by_status).map(([k, v]) => [t(`vstatus.${k}`), v])} /></Card>
            <Card><Stat value={r.open_resource_reports} label={t('report.open_resource_reports')} tone={r.open_resource_reports ? 'warn' : ''} /></Card>
          </div>)}
      </AsyncView>
    </>);
}
