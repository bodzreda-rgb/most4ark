import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { AsyncView, Card, Empty, PageHead, Stat, StatusBadge } from '../../components/ui.jsx';

export default function Overview() {
  const { t, lang } = useI18n();
  const { tz, can } = useAuth();
  const nav = useNavigate();
  const stats = useAsync(async () => unwrap(await supabase.rpc('admin_dashboard_stats')), []);
  const pending = useAsync(async () => (can('lawyers.review') ? unwrap(await supabase.rpc('admin_list_lawyers', { p_status: 'submitted' })) : []), []);
  const activity = useAsync(async () => (can('audit.read') ? unwrap(await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(8)) : []), []);
  return (
    <>
      <PageHead title={t('nav.overview')} subtitle={t('admin.overview_sub')} />
      <AsyncView state={stats}>
        {(s) => (
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Card><Stat value={s.total_users} label={t('admin.total_users')} /></Card>
            <Card><Stat value={s.approved_lawyers} label={t('admin.approved_lawyers')} /></Card>
            <Card><Link to="/admin/lawyers?status=submitted" style={{ color: 'inherit', textDecoration: 'none' }}><Stat value={s.pending_applications} label={t('admin.pending_applications')} tone={s.pending_applications ? 'warn' : ''} /></Link></Card>
            <Card><Stat value={`${s.rejected_applications} / ${s.suspended_lawyers}`} label={t('admin.rejected_suspended')} /></Card>
            <Card><Stat value={s.total_consultations} label={t('admin.total_consultations')} /></Card>
            <Card><Stat value={s.pending_consultations} label={t('admin.pending_consultations')} tone={s.pending_consultations ? 'warn' : ''} /></Card>
            <Card><Stat value={s.assigned_consultations} label={t('admin.assigned_consultations')} /></Card>
            <Card><Stat value={s.answered_consultations} label={t('admin.answered_consultations')} /></Card>
          </div>)}
      </AsyncView>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        {can('lawyers.review') && (
          <Card title={t('admin.pending_applications')} actions={<Link to="/admin/lawyers">{t('common.view_all')}</Link>}>
            <AsyncView state={pending} empty={<Empty glyph="✅" title={t('admin.no_pending')} />}>
              {(rows) => <div className="list">{rows.slice(0, 8).map((r) => (
                <div className="list-item clickable" key={r.user_id} onClick={() => nav(`/admin/lawyers/${r.user_id}`)}>
                  <span className="grow">{r.full_legal_name || t('admin.application')} <span className="muted small">· {r.city}</span></span>
                  <span className="small muted">{formatDateTime(r.submitted_at, tz, lang)}</span></div>))}</div>}
            </AsyncView>
          </Card>)}
        {can('audit.read') && (
          <Card title={t('admin.recent_activity')} actions={<Link to="/admin/audit">{t('common.view_all')}</Link>}>
            <AsyncView state={activity} empty={<Empty glyph="🧾" title={t('admin.no_activity')} />}>
              {(rows) => <div className="list">{rows.map((a) => (
                <div className="list-item" key={a.id}><span className="grow ltr small">{a.action}</span><StatusBadge status={a.result} prefix="audit.result" />
                  <span className="small muted nowrap">{formatDateTime(a.created_at, tz, lang)}</span></div>))}</div>}
            </AsyncView>
          </Card>)}
      </div>
    </>);
}
