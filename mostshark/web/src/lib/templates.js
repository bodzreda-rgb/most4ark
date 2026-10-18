// Document template helpers: {{field_key}} placeholders.

const RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function placeholdersOf(body = '') {
  const keys = [];
  for (const m of body.matchAll(RE)) if (!keys.includes(m[1])) keys.push(m[1]);
  return keys;
}

/** Fills known values; unfilled placeholders are left visible so nothing is silently dropped. */
export function fillTemplate(body = '', values = {}) {
  return body.replace(RE, (whole, key) => {
    const v = values[key];
    return v === undefined || v === null || String(v).trim() === '' ? whole : String(v);
  });
}

export function missingFields(body = '', values = {}) {
  return placeholdersOf(body).filter((k) => !values[k] || String(values[k]).trim() === '');
}

/** Builds default field descriptors from the body when `fields` is empty. */
export function fieldsFor(template) {
  const declared = Array.isArray(template.fields) ? template.fields : [];
  const known = new Map(declared.map((f) => [f.key, f]));
  return placeholdersOf(template.body || '').map((k) => known.get(k) || { key: k, label_ar: k, label_en: k, type: 'text' });
}
