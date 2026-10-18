import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap, useDebounced } from '../../lib/hooks.js';
import { formatDate } from '../../lib/dates.js';
import { AsyncView, Button, ConfirmDialog, Empty, PageHead, SearchBox, Select, StatusBadge, useErrorToast, useToast } from '../../components/ui.jsx';

export default function AdminUsers() {
  const { t, lang } = useI18n();
  const { tz, can, user } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [type, setType] = useState(''); const [status, setStatus] = useState('');
  const [act, setAct] = useState(null);
  const state = useAsync(async () => unwrap(await supabase.rpc('admin_list_users', { p_type: type || null, p_status: status || null, p_search: dq || null })), [type, status, dq]);
  const apply = async (reason) => {
    try { unwrap(await supabase.rpc('admin_set_account_status', { p_user: act.id, p_status: act.status, p_reason: reason || null })); setAct(null); toast(t('common.saved'), 'success'); state.reload(); }
    catch (e) { onError(e); }
  };
  return (
    <>
      <PageHead title={t('nav.users')} />
      <div className="row" style={{ marginBottom: 16 }}>
        <SearchBox value={q} onChange={setQ} placeholder={t('admin.user_search')} />
        <Select style={{ maxWidth: 180 }} value={type} onChange={(e) => setType(e.target.value)} aria-label={t('admin.account_type')}>
          <option value="">{t('common.all')}</option>{['client', 'lawyer', 'admin'].map((x) => <option key={x} value={x}>{t(`role.${x}`)}</option>)}</Select>
        <Select style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
          <option value="">{t('common.all_statuses')}</option>{['active', 'suspended', 'deactivated'].map((x) => <option key={x} value={x}>{t(`acct.${x}`)}</option>)}</Select>
      </div>
      <AsyncView state={state} empty={<Empty glyph="👥" title={t('admin.no_users')} />}>
        {(rows) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('auth.full_name')}</th><th>{t('auth.email')}</th><th>{t('admin.account_type')}</th><th>{t('common.status')}</th><th>{t('admin.joined')}</th><th /></tr></thead>
            <tbody>{rows.map((u) => (
              <tr key={u.id}>
                <td>{u.identity_hidden ? <span className="muted">{t('admin.identity_hidden')}</span> : u.full_name}</td>
                <td className="ltr">{u.identity_hidden ? '—' : u.email}</td>
                <td>{t(`role.${u.account_type}`)}</td><td><StatusBadge status={u.status} prefix="acct" /></td><td>{formatDate(u.created_at, tz, lang)}</td>
                <td className="nowrap">{can('users.manage') && u.id !== user.id && u.account_type !== 'admin' && (u.status === 'active'
                  ? <Button size="sm" variant="danger" onClick={() => setAct({ id: u.id, status: 'suspended' })}>{t('admin.suspend_account')}</Button>
                  : <Button size="sm" onClick={() => setAct({ id: u.id, status: 'active' })}>{t('admin.activate_account')}</Button>)}</td></tr>))}</tbody></table></div>)}
      </AsyncView>
      {act && <ConfirmDialog title={t('admin.account_controls')} message={t('common.cannot_undo')} danger={act.status !== 'active'} requireReason={act.status !== 'active'} onCancel={() => setAct(null)} onConfirm={apply} />}
    </>);
}
