import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { formatDate } from '../../lib/dates.js';
import { Alert, AsyncView, Empty, PageHead, StatusBadge } from '../../components/ui.jsx';

export default function LawyerConsultations() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const state = useAsync(async () => unwrap(await supabase.from('consultations').select('id,reference_no,title,status,created_at,category:consultation_categories(name_ar,name_en)').order('updated_at', { ascending: false })), []);
  return (
    <>
      <PageHead title={t('nav.consultations')} subtitle={t('cons.lawyer_subtitle')} />
      <Alert tone="info" className="small">{t('cons.lawyer_scope')}</Alert>
      <div style={{ marginTop: 16 }}>
        <AsyncView state={state} empty={<Empty glyph="💬" title={t('cons.empty_lawyer')} />}>
          {(rows) => (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{t('cons.reference')}</th><th>{t('cons.title')}</th><th>{t('cons.category')}</th><th>{t('common.status')}</th><th>{t('common.created')}</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/lawyer/consultations/${r.id}`)}>
                  <td className="ltr nowrap">{r.reference_no}</td><td>{r.title}</td><td>{r.category ? (lang === 'ar' ? r.category.name_ar : r.category.name_en) : '—'}</td>
                  <td><StatusBadge status={r.status} prefix="cons.status" /></td><td className="nowrap">{formatDate(r.created_at, tz, lang)}</td></tr>))}</tbody></table></div>)}
        </AsyncView>
      </div>
    </>);
}
