import { useState } from 'react';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { Alert, AsyncView, Card, PageHead, useErrorToast, useToast } from '../../components/ui.jsx';
import { LawyerForm } from './Application.jsx';
import Account from '../shared/Account.jsx';

export default function LawyerProfile() {
  const { t } = useI18n();
  const { user, lawyer, refresh } = useAuth();
  const toast = useToast(); const onError = useErrorToast();
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(null);
  const data = useAsync(async () => {
    const [specs, mine] = await Promise.all([
      supabase.from('specializations').select('*').eq('is_active', true).order('sort_order'),
      supabase.from('lawyer_specializations').select('specialization_id').eq('lawyer_id', user.id)]);
    return { specs: unwrap(specs), mine: unwrap(mine).map((r) => r.specialization_id) };
  }, [user.id]);

  return (
    <>
      <PageHead title={t('lawyer.public_profile')} subtitle={t('lawyer.public_profile_hint')} />
      <Alert tone="info">{t('lawyer.alias_is')}: <strong className="ltr">{lawyer?.public_alias}</strong> — {t('lawyer.alias_note')}</Alert>
      <AsyncView state={data}>{(d) => {
        const sel = selected ?? d.mine;
        const save = async (row) => {
          setSaving(true);
          try {
            unwrap(await supabase.from('lawyer_profiles').update(row).eq('user_id', user.id));
            const add = sel.filter((x) => !d.mine.includes(x)); const del = d.mine.filter((x) => !sel.includes(x));
            if (add.length) unwrap(await supabase.from('lawyer_specializations').insert(add.map((id) => ({ lawyer_id: user.id, specialization_id: id }))));
            if (del.length) unwrap(await supabase.from('lawyer_specializations').delete().eq('lawyer_id', user.id).in('specialization_id', del));
            await refresh(); data.reload(); setSelected(null); toast(t('common.saved'), 'success');
          } catch (e) { onError(e); } finally { setSaving(false); }
        };
        return (
          <div style={{ marginTop: 16 }}>
            <Card><LawyerForm initial={lawyer || {}} specs={d.specs} selectedSpecs={sel}
              onChangeSpecs={(id) => setSelected(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])}
              identityLocked onSave={save} saving={saving} /></Card>
          </div>);
      }}</AsyncView>
      <div style={{ marginTop: 24 }}><Account /></div>
    </>
  );
}
