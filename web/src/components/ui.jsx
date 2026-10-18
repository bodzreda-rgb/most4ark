import { cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../lib/i18n.jsx';
import { errorKey } from '../lib/errors.js';

/* ---------------- Toasts ---------------- */
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, message, type }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((i) => <div key={i.id} className={`toast ${i.type}`}>{i.message}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Shows a translated error toast. */
export function useErrorToast() {
  const toast = useToast();
  const { t } = useI18n();
  return useCallback((e) => toast(t(errorKey(e)), 'error'), [toast, t]);
}

/* ---------------- Basic controls ---------------- */
export function Button({ variant = 'secondary', size, block, loading, children, className = '', ...rest }) {
  const cls = `btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${block ? 'btn-block' : ''} ${className}`;
  return <button className={cls} disabled={loading || rest.disabled} {...rest}>{loading ? '…' : children}</button>;
}

export function Field({ label, hint, error, children, className = '' }) {
  const id = useId();
  const child = children && children.type
    ? cloneElement(children, { id, 'aria-invalid': error ? 'true' : undefined })
    : children;
  return (
    <div className={`field ${className}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {child}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="err" role="alert">{error}</span>}
    </div>
  );
}

export const Input = (props) => <input className="input" {...props} />;
export const Textarea = (props) => <textarea className="input" {...props} />;
export function Select({ children, ...props }) { return <select className="input" {...props}>{children}</select>; }

export function Checkbox({ label, ...props }) {
  return <label className="check"><input type="checkbox" {...props} /><span>{label}</span></label>;
}

/* ---------------- Layout atoms ---------------- */
export const Card = ({ title, actions, children, className = '', flat }) => (
  <section className={`card ${flat ? 'flat' : ''} ${className}`}>
    {(title || actions) && <div className="card-title">{title && <h3>{title}</h3>}{actions && <div className="row">{actions}</div>}</div>}
    {children}
  </section>
);

export const Stat = ({ value, label, tone }) => (
  <div className={`stat ${tone || ''}`}><span className="num">{value}</span><span className="lbl">{label}</span></div>
);

/** Photo shown behind each page header, chosen from the section of the app. */
const HERO_BY_SECTION = [
  [/\/library/, 'library'], [/\/templates/, 'contract'], [/\/(directory|clients|users|lawyers)/, 'suit'],
  [/\/(consultations|new)/, 'columns'], [/\/(cases|calendar)/, 'gavel'], [/\/(finance|reports)/, 'contract'],
  [/\/(audit|settings|notifications|profile)/, 'books'],
];
export const heroFor = (path) => (HERO_BY_SECTION.find(([re]) => re.test(path)) || [null, 'statue'])[1];

export const PageHead = ({ title, subtitle, actions }) => {
  const { pathname } = useLocation();
  return (
    <div className="page-head page-hero" style={{ backgroundImage: `url(/img/${heroFor(pathname)}.jpg)` }}>
      <div className="page-hero-text"><h1>{title}</h1>{subtitle && <p style={{ margin: 0 }}>{subtitle}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
};

const TONES = {
  approved: 'success', answered: 'success', completed: 'success', paid: 'success', active: 'success', published: 'success', verified: 'success', closed: 'neutral',
  submitted: 'info', under_review: 'info', assigned: 'info', in_progress: 'info', scheduled: 'info', open: 'info', pending: 'info', new: 'info',
  awaiting_info: 'warn', awaiting_hearing: 'warn', awaiting_documents: 'warn', awaiting_payment: 'warn', draft: 'neutral', unverified: 'warn', unpublished: 'neutral',
  rejected: 'danger', suspended: 'danger', cancelled: 'neutral', outdated: 'danger', deactivated: 'danger', archived: 'neutral', denied: 'danger', error: 'danger',
};
export function StatusBadge({ status, prefix = 'status' }) {
  const { t } = useI18n();
  return <span className={`badge ${TONES[status] || 'neutral'}`}>{t(`${prefix}.${status}`)}</span>;
}

export const Alert = ({ tone = 'info', children, className = '' }) => (
  <div className={`alert ${tone} ${className}`} role={tone === 'danger' ? 'alert' : 'note'}>{children}</div>
);

export const Spinner = () => <div className="spinner" role="progressbar" aria-label="loading" />;

export function Empty({ glyph = '🗂️', title, children }) {
  return <div className="empty"><div className="glyph" aria-hidden="true">{glyph}</div><strong>{title}</strong>{children && <p className="small">{children}</p>}</div>;
}

/** Standard loading / error / empty handling for useAsync results. */
export function AsyncView({ state, empty, children }) {
  const { t } = useI18n();
  if (state.loading && !state.data) return <Spinner />;
  if (state.error) {
    return (
      <Alert tone="danger">
        {t(errorKey(state.error))}{' '}
        <button className="btn btn-sm btn-secondary" onClick={state.reload}>{t('common.retry')}</button>
      </Alert>
    );
  }
  const d = state.data;
  if (empty && (d == null || (Array.isArray(d) && d.length === 0))) return empty;
  return children(d);
}

/* ---------------- Modal / confirm ---------------- */
export function Modal({ title, onClose, children, actions, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <h2>{title}</h2>
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger, requireReason, onConfirm, onCancel }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onCancel} actions={<>
      <Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={requireReason && !reason.trim()}
        onClick={async () => { setBusy(true); try { await onConfirm(reason.trim()); } finally { setBusy(false); } }}>
        {confirmLabel || t('common.confirm')}
      </Button>
    </>}>
      {message && <p>{message}</p>}
      {requireReason && (
        <Field label={t('common.reason')}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      )}
    </Modal>
  );
}

/* ---------------- Tabs / segmented ---------------- */
export function Tabs({ value, onChange, items }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.value} role="tab" className="tab" aria-selected={value === i.value} onClick={() => onChange(i.value)}>{i.label}</button>
      ))}
    </div>
  );
}
export function Segmented({ value, onChange, items }) {
  return (
    <div className="seg" role="group">
      {items.map((i) => <button key={i.value} aria-pressed={value === i.value} onClick={() => onChange(i.value)}>{i.label}</button>)}
    </div>
  );
}

/* ---------------- Misc ---------------- */
export function Disclaimer({ text }) {
  if (!text) return null;
  return <Alert tone="warn">⚠️ {text}</Alert>;
}

export function KV({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}
    </dl>
  );
}

export function SearchBox({ value, onChange, placeholder }) {
  return <input className="input" type="search" style={{ maxWidth: 320 }} value={value} placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />;
}
