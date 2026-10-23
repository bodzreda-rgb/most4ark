import { supabase } from './supabase.js';
import { useAsync } from './hooks.js';
import { useI18n } from './i18n.jsx';

let cache = null;
async function load() {
  if (cache) return cache;
  const { data } = await supabase.from('platform_settings').select('key,value').eq('is_public', true);
  cache = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return cache;
}
export function invalidateSettings() { cache = null; }

/** Public settings + localized helper for disclaimers (`disclaimer_<name>_ar|en`). */
export function usePublicSettings() {
  const { lang } = useI18n();
  const state = useAsync(load, []);
  const s = state.data || {};
  return {
    settings: s,
    loading: state.loading,
    reload: () => { invalidateSettings(); state.reload(); },
    disclaimer: (name) => s[`disclaimer_${name}_${lang}`] || s[`disclaimer_${name}_ar`] || '',
    maxUploadMb: Number(s.max_upload_mb || 10),
    rangeDays: Number(s.calendar_default_range_days || 30),
  };
}
