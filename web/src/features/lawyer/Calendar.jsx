import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, useDebounced } from '../../lib/hooks.js';
import { addDays, addMonths, dayKeyOf, formatDayKey, formatMonth, formatTime, rangeFor, startOfMonth, todayKey, weekdayLabels } from '../../lib/dates.js';
import { EVENT_KINDS } from '../../lib/eventKinds.js';
import { filterItems, loadSchedule } from '../../lib/schedule.js';
import { usePublicSettings } from '../../lib/settings.js';
import { fmtMoney } from '../../lib/finance.js';
import { AsyncView, Button, Card, Empty, PageHead, SearchBox, Segmented, StatusBadge } from '../../components/ui.jsx';
import EventModal from './EventModal.jsx';

export function useSchedule(view, anchor) {
  const { tz } = useAuth();
  const { rangeDays } = usePublicSettings();
  const range = useMemo(() => rangeFor(view, anchor, tz, rangeDays), [view, anchor, tz, rangeDays]);
  const state = useAsync(() => loadSchedule(range.fromIso, range.toIso, { fromDay: range.first, toDay: range.last }), [range.fromIso, range.toIso]);
  return { range, state };
}

export function KindMark({ kind, label }) {
  const k = EVENT_KINDS[kind] || EVENT_KINDS.personal;
  return <span className="kind"><span className="kind-dot" style={{ background: k.color }} aria-hidden="true">{k.icon}</span>{label}</span>;
}

export function groupByDay(items, tz) {
  const m = new Map();
  for (const i of items) {
    const key = i.due_on || dayKeyOf(i.starts_at, tz);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(i);
  }
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

export function AgendaItem({ item, onClick }) {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const cancelled = item.status === 'cancelled';
  return (
    <div className="list-item clickable" onClick={() => onClick(item)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick(item)}
      style={{ opacity: cancelled ? 0.55 : 1 }}>
      <span className="nowrap small muted" style={{ width: 74 }}>{item.starts_at ? formatTime(item.starts_at, tz, lang) : t('cal.all_day')}</span>
      <KindMark kind={item.kind} label="" />
      <div className="grow">
        <strong style={{ textDecoration: cancelled ? 'line-through' : 'none' }}>
          {item.title || t(`kind.${item.kind}`)}{item.amount ? ` — ${fmtMoney(item.amount, lang)}` : ''}</strong>
        <div className="small muted">{t(`kind.${item.kind}`)}{item.case ? ` · ${item.case.title}` : ''}{item.client ? ` · ${item.client.full_name}` : ''}{item.location_text ? ` · ${item.location_text}` : ''}</div>
      </div>
      {item.kind === 'hearing' && item.source === 'user_entered' && <span className="badge warn" title={t('cal.hearing_unverified')}>{t('cal.source.user_entered')}</span>}
      {item.status !== 'scheduled' && <StatusBadge status={item.status} prefix="evstatus" />}
    </div>
  );
}

function MonthGrid({ items, range, anchor, onDay, onItem }) {
  const { lang } = useI18n();
  const { tz } = useAuth();
  const today = todayKey(tz);
  const byDay = useMemo(() => new Map(groupByDay(items, tz)), [items, tz]);
  const month = anchor.slice(0, 7);
  return (
    <div className="cal-grid" role="grid">
      {weekdayLabels(lang).map((w) => <div key={w} className="cal-head" role="columnheader">{w}</div>)}
      {range.days.map((d) => {
        const evs = byDay.get(d) || [];
        return (
          <div key={d} role="gridcell" className={`cal-cell ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''}`} onClick={() => onDay(d)}>
            <span className="dnum">{Number(d.slice(8))}</span>
            {evs.slice(0, 3).map((e) => (
              <button key={e.key} className={`cal-ev ${e.status === 'cancelled' ? 'cancelled' : ''}`} style={{ background: (EVENT_KINDS[e.kind] || EVENT_KINDS.personal).color }}
                onClick={(ev) => { ev.stopPropagation(); onItem(e); }}>{(EVENT_KINDS[e.kind] || {}).icon} {e.title}</button>))}
            {evs.length > 3 && <span className="small muted">+{evs.length - 3}</span>}
          </div>);
      })}
    </div>);
}

export default function Calendar() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const { rangeDays } = usePublicSettings();
  const [view, setView] = useState('month');
  const [anchor, setAnchor] = useState(todayKey(tz));
  const [kinds, setKinds] = useState(new Set());
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const { range, state } = useSchedule(view, anchor);
  const [editing, setEditing] = useState(null);       // {event?, defaults?}
  const nav = useNavigate();

  const step = (dir) => {
    if (view === 'day') setAnchor(addDays(anchor, dir));
    else if (view === 'week') setAnchor(addDays(anchor, 7 * dir));
    else if (view === 'month') setAnchor(addMonths(startOfMonth(anchor), dir));
    else setAnchor(addDays(anchor, rangeDays * dir));
  };
  const title = view === 'month' ? formatMonth(anchor, lang)
    : view === 'day' ? formatDayKey(anchor, lang)
    : `${formatDayKey(range.first, lang, { day: 'numeric', month: 'short' })} – ${formatDayKey(range.last, lang, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const toggleKind = (k) => { const n = new Set(kinds); if (n.has(k)) n.delete(k); else n.add(k); setKinds(n); };

  const openItem = (it) => {
    if (it.source === 'event') setEditing({ event: it });
    else if (it.source === 'task') nav('/lawyer');       // tasks are managed on the dashboard
    else nav('/lawyer/finance?tab=expected');
  };
  const newOn = (d) => setEditing({ defaults: { start: `${d}T10:00` } });

  return (
    <>
      <PageHead title={t('nav.calendar')} subtitle={t('cal.subtitle', { n: rangeDays })} actions={<Button variant="primary" onClick={() => setEditing({ defaults: { start: `${anchor}T10:00` } })}>➕ {t('cal.new_event')}</Button>} />
      <div className="row between" style={{ marginBottom: 12 }}>
        <Segmented value={view} onChange={setView} items={[
          { value: 'day', label: t('cal.view.day') }, { value: 'week', label: t('cal.view.week') },
          { value: 'month', label: t('cal.view.month') }, { value: 'next30', label: t('cal.view.next', { n: rangeDays }) }]} />
        <div className="row">
          <Button size="sm" onClick={() => step(-1)} aria-label={t('common.previous')}>{lang === 'ar' ? '›' : '‹'}</Button>
          <strong style={{ minWidth: 160, textAlign: 'center' }}>{title}</strong>
          <Button size="sm" onClick={() => step(1)} aria-label={t('common.next')}>{lang === 'ar' ? '‹' : '›'}</Button>
          <Button size="sm" onClick={() => setAnchor(todayKey(tz))}>{t('cal.today')}</Button>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <SearchBox value={q} onChange={setQ} placeholder={t('common.search')} />
        {Object.keys(EVENT_KINDS).map((k) => (
          <button key={k} className="chip" aria-pressed={kinds.has(k)} onClick={() => toggleKind(k)}
            style={{ cursor: 'pointer', border: '1px solid ' + (kinds.has(k) ? EVENT_KINDS[k].color : 'transparent'), background: kinds.has(k) ? 'var(--surface)' : undefined }}>
            {EVENT_KINDS[k].icon} {t(`kind.${k}`)}</button>))}
      </div>
      <AsyncView state={state}>
        {(items) => {
          const shown = filterItems(items, { kinds, q: dq });
          if (view === 'month') return <MonthGrid items={shown} range={range} anchor={anchor} onDay={newOn} onItem={openItem} />;
          const groups = groupByDay(shown, tz);
          if (!groups.length) return <Card><Empty glyph="📅" title={t('cal.empty')}>{t('cal.empty_hint')}</Empty></Card>;
          return (
            <div className="stack">{groups.map(([d, list]) => (
              <Card key={d} title={formatDayKey(d, lang)}>
                <div className="list">{list.map((it) => <AgendaItem key={it.key} item={it} onClick={openItem} />)}</div>
              </Card>))}</div>);
        }}
      </AsyncView>
      {editing && <EventModal event={editing.event} defaults={editing.defaults} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); state.reload(); }} />}
    </>
  );
}
