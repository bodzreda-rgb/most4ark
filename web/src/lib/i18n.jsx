import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ar } from '../locales/ar.js';
import { en } from '../locales/en.js';

const DICTS = { ar, en };
const I18nContext = createContext(null);

function readLang() {
  try { const v = localStorage.getItem('ms_lang'); if (v === 'ar' || v === 'en') return v; } catch { /* storage unavailable */ }
  return 'ar';   // Arabic is the default
}

export function translate(lang, key, vars) {
  let s = DICTS[lang]?.[key] ?? DICTS.ar[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(readLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  const setLang = useCallback((l) => {
    setLangState(l);
    try { localStorage.setItem('ms_lang', l); } catch { /* ignore */ }
  }, []);
  const value = useMemo(() => ({
    lang, setLang, dir: lang === 'ar' ? 'rtl' : 'ltr',
    t: (key, vars) => translate(lang, key, vars),
  }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
