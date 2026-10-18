import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/dates.js';
import { AsyncView, Empty, PageHead, Select, StatusBadge } from '../../components/ui.jsx';

const STATUSES = ['submitted', 'under_review', 'awaiting_info', 'assigned', 'in_progress', 'answered', 'closed', 'rejected'];

export default function AdminConsultations() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const state = useAsync(async () => {
    let q = supabase.from('consultations').select('id, reference_no, title, status, created_at, category:consultation_categories(name_ar, name_en)').order('created_at', { ascending: false }).limit(200);
    if (status) q = q.eq('status', status);
    return unwrap(await q);
  }, [status]);
  return (
    <>
      <PageHead title={t('nav.consultations')} />
      <div className="row" style={{ marginBottom: 16 }}>
        <Select style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('common.status')}>
          <option value="">{t('common.all_statuses')}</option>{STATUSES.map((s) => <option key={s} value={s}>{t(`cons.status.${s}`)}</option>)}</Select>
      </div>
      <AsyncView state={state} empty={<Empty glyph="💬" title={t('cons.none')} />}>
        {(rows) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('cons.reference')}</th><th>{t('cons.title')}</th><th>{t('common.status')}</th><th>{t('cons.category')}</th><th>{t('common.created')}</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => nav(`/admin/consultations/${c.id}`)}>
                <td className="ltr">{c.reference_no}</td><td>{c.title}</td><td><StatusBadge status={c.status} prefix="cons.status" /></td>
                <td>{c.category ? (lang === 'ar' ? c.category.name_ar : c.category.name_en) : '—'}</td><td className="nowrap">{formatDateTime(c.created_at, tz, lang)}</td></tr>))}</tbody></table></div>)}
      </AsyncView>
    </>);
}
