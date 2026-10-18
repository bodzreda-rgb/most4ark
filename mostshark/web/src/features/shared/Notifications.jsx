import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { useI18n } from '../../lib/i18n.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { formatDateTime } from '../../lib/dates.js';
import { AsyncView, Button, Empty, PageHead, useErrorToast } from '../../components/ui.jsx';

// Where each notification opens, by account type. Text is generic by design:
// confidential details are only shown after the user opens the record.
function targetFor(n, base) {
  const id = n.entity_id;
  switch (n.entity_type) {
    case 'consultation': return `${base}/consultations/${id}`;
    case 'case': return `${base}/cases/${id}`;
    case 'lawyer': return base === '/admin' ? `/admin/lawyers/${id}` : '/lawyer/application';
    case 'calendar_event': return '/lawyer/calendar';
    default: return null;
  }
}

export default function Notifications({ base }) {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const onError = useErrorToast();
  const state = useAsync(async () => unwrap(await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(100)), []);

  const open = async (n) => {
    try {
      if (!n.read_at) unwrap(await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id));
      const to = targetFor(n, base === '/client' ? '/client' : base);
      state.reload();
      if (to) nav(to);
    } catch (e) { onError(e); }
  };
  const markAll = async () => {
    try { unwrap(await supabase.rpc('mark_all_notifications_read')); state.reload(); } catch (e) { onError(e); }
  };

  return (
    <>
      <PageHead title={t('nav.notifications')} actions={<Button size="sm" onClick={markAll}>{t('notif.mark_all')}</Button>} />
      <AsyncView state={state} empty={<Empty glyph="🔔" title={t('notif.empty')} />}>
        {(rows) => (
          <div className="card list">
            {rows.map((n) => (
              <div key={n.id} className="list-item clickable" onClick={() => open(n)} role="button" tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && open(n)}>
                <span aria-hidden="true">{n.read_at ? '○' : '●'}</span>
                <div className="grow">
                  <strong style={{ fontWeight: n.read_at ? 500 : 700 }}>{n.title || t(`notif.kind.${n.kind}`)}</strong>
                  {n.body && <div className="small muted">{n.body}</div>}
                </div>
                <span className="small muted nowrap">{formatDateTime(n.created_at, tz, lang)}</span>
              </div>
            ))}
          </div>
        )}
      </AsyncView>
    </>
  );
}
