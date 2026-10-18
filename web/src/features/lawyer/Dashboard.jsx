import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { useAsync, unwrap } from '../../lib/hooks.js';
import { dayKeyOf, formatDateTime, todayKey, formatDayKey } from '../../lib/dates.js';
import { fmtMoney } from '../../lib/finance.js';
import { AsyncView, Button, Card, Empty, Input, PageHead, PhotoTiles, Segmented, Stat, StatusBadge, useErrorToast } from '../../components/ui.jsx';
import { AgendaItem, groupByDay, useSchedule } from './Calendar.jsx';
import EventModal from './EventModal.jsx';
import { usePublicSettings } from '../../lib/settings.js';

function Tasks({ onChange }) {
  const { t, lang } = useI18n();
  const { tz, user } = useAuth();
  const onError = useErrorToast();
  const [title, setTitle] = useState('');
  const state = useAsync(async () => unwrap(await supabase.from('tasks').select('*').is('deleted_at', null).eq('status', 'open')
    .order('due_at', { ascending: true, nullsFirst: false }).limit(12)), []);
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    try { unwrap(await supabase.from('tasks').insert({ lawyer_id: user.id, title: title.trim() })); setTitle(''); state.reload(); onChange?.(); }
    catch (err) { onError(err); }
  };
  const done = async (id) => {
    try { unwrap(await supabase.from('tasks').update({ status: 'done' }).eq('id', id)); state.reload(); onChange?.(); } catch (err) { onError(err); }
  };
  const now = Date.now();
  return (
    <Card title={t('dash.tasks')}>
      <form className="row" onSubmit={add} style={{ marginBottom: 8, flexWrap: 'nowrap' }}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('dash.add_task')} aria-label={t('dash.add_task')} />
        <Button type="submit" variant="primary">{t('common.add')}</Button>
      </form>
      <AsyncView state={state} empty={<Empty glyph="✅" title={t('dash.no_tasks')} />}>
        {(rows) => <div className="list">{rows.map((k) => (
          <div className="list-item" key={k.id}>
            <input type="checkbox" aria-label={t('cal.mark_done')} onChange={() => done(k.id)} style={{ width: 18, height: 18 }} />
            <span className="grow">{k.title}{k.priority === 'high' && ' 🔥'}</span>
            {k.due_at && <span className={`small ${new Date(k.due_at).getTime() < now ? '' : 'muted'}`} style={{ color: new Date(k.due_at).getTime() < now ? 'var(--danger)' : undefined }}>{formatDateTime(k.due_at, tz, lang)}</span>}
          </div>))}</div>}
      </AsyncView>
    </Card>
  );
}

export default function Dashboard() {
  const { t, lang } = useI18n();
  const { tz } = useAuth();
  const nav = useNavigate();
  const { rangeDays } = usePublicSettings();
  const today = todayKey(tz);
  const [view, setView] = useState('next30');
  const [editing, setEditing] = useState(null);

  const sum = useAsync(async () => unwrap(await supabase.rpc('lawyer_dashboard_summary')), []);
  const agenda = useSchedule(view, today);
  const upcoming = useSchedule('next30', today);

  const money = useAsync(async () => {
    const [bal, tx, cases, notifs] = await Promise.all([
      supabase.from('client_balances').select('client_id,outstanding').gt('outstanding', 0).order('outstanding', { ascending: false }).limit(5),
      supabase.from('financial_transactions').select('id,kind,amount,occurred_on,description,case_id').order('created_at', { ascending: false }).limit(6),
      supabase.from('cases').select('id,status').is('deleted_at', null),
      supabase.from('notifications').select('*').is('read_at', null).order('created_at', { ascending: false }).limit(5),
    ]);
    const balances = unwrap(bal);
    let names = {};
    if (balances.length) {
      const c = unwrap(await supabase.from('clients').select('id,full_name').in('id', balances.map((b) => b.client_id)));
      names = Object.fromEntries(c.map((x) => [x.id, x.full_name]));
    }
    const byStatus = {};
    for (const c of unwrap(cases)) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    return { balances: balances.map((b) => ({ ...b, name: names[b.client_id] || '—' })), tx: unwrap(tx), byStatus, notifs: unwrap(notifs) };
  }, []);

  const s = sum.data || {};
  const items = upcoming.state.data || [];
  const todays = items.filter((i) => i.source === 'event' && i.kind === 'appointment' && i.status === 'scheduled' && dayKeyOf(i.starts_at, tz) === today);
  const hearings = items.filter((i) => i.kind === 'hearing' && i.status === 'scheduled');
  const deadlines = items.filter((i) => ['case_deadline', 'payment_deadline'].includes(i.kind) && i.status === 'scheduled');
  const meetings = items.filter((i) => i.source === 'event' && i.kind === 'appointment' && i.status === 'scheduled' && dayKeyOf(i.starts_at, tz) > today);

  const Section = ({ title, list, empty }) => (
    <Card title={title}>
      {list.length === 0 ? <p className="muted small" style={{ margin: 0 }}>{empty}</p>
        : <div className="list">{list.slice(0, 6).map((it) => (
          <div key={it.key}>
            <div className="small muted" style={{ paddingTop: 6 }}>{formatDayKey(it.due_on || dayKeyOf(it.starts_at, tz), lang, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
            <AgendaItem item={it} onClick={(i) => (i.source === 'event' ? setEditing({ event: i }) : nav(i.source === 'payment' ? '/lawyer/finance?tab=expected' : '/lawyer/calendar'))} />
          </div>))}</div>}
    </Card>);

  return (
    <>
      <PageHead title={t('nav.dashboard')} subtitle={t('dash.subtitle', { n: rangeDays })}
        actions={<><Button variant="primary" onClick={() => setEditing({ defaults: { start: `${today}T10:00` } })}>➕ {t('cal.new_event')}</Button></>} />
      <PhotoTiles items={[
        { to: '/lawyer/cases', img: 'gavel', label: t('nav.cases') },
        { to: '/lawyer/clients', img: 'suit', label: t('nav.clients') },
        { to: '/lawyer/library', img: 'library', label: t('nav.library') },
        { to: '/lawyer/calendar', img: 'books', label: t('nav.calendar') },
      ]} />
      <AsyncView state={sum}>
        {() => (
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Card><Stat value={s.active_cases ?? 0} label={t('dash.active_cases')} /></Card>
            <Card><Stat value={fmtMoney(s.outstanding_total, lang)} label={t('dash.outstanding')} tone={Number(s.outstanding_total) > 0 ? 'warn' : ''} /></Card>
            <Card><Stat value={s.overdue_count ?? 0} label={`${t('dash.overdue')}${s.overdue_count ? ' · ' + fmtMoney(s.overdue_amount, lang) : ''}`} tone={s.overdue_count ? 'danger' : ''} /></Card>
            <Card><Link to="/lawyer/consultations" style={{ textDecoration: 'none', color: 'inherit' }}><Stat value={s.pending_consultations ?? 0} label={t('dash.pending_consultations')} /></Link></Card>
          </div>)}
      </AsyncView>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Card title={t('dash.agenda')} actions={<Segmented value={view} onChange={setView} items={[
            { value: 'day', label: t('cal.view.day') }, { value: 'week', label: t('cal.view.week') },
            { value: 'month', label: t('cal.view.month') }, { value: 'next30', label: t('cal.view.next', { n: rangeDays }) }]} />}>
            <AsyncView state={agenda.state} empty={<Empty glyph="📅" title={t('cal.empty')} />}>
              {(rows) => {
                const groups = groupByDay(rows.filter((r) => r.status !== 'cancelled'), tz);
                if (!groups.length) return <Empty glyph="📅" title={t('cal.empty')} />;
                return <div className="stack">{groups.slice(0, 8).map(([d, list]) => (
                  <div key={d}><strong className="small">{formatDayKey(d, lang)}</strong>
                    <div className="list">{list.map((it) => <AgendaItem key={it.key} item={it} onClick={(i) => (i.source === 'event' ? setEditing({ event: i }) : nav('/lawyer/calendar'))} />)}</div></div>))}
                  <Link to="/lawyer/calendar">{t('dash.open_calendar')} →</Link></div>;
              }}
            </AsyncView>
          </Card>
          <Section title={t('dash.today_appointments')} list={todays} empty={t('dash.none_today')} />
          <Section title={t('dash.upcoming_hearings')} list={hearings} empty={t('dash.none_hearings')} />
          <Section title={t('dash.deadlines')} list={deadlines} empty={t('dash.none_deadlines')} />
          <Section title={t('dash.meetings')} list={meetings} empty={t('dash.none_meetings')} />
        </div>

        <div className="stack">
          <Tasks onChange={sum.reload} />
          <AsyncView state={money}>
            {(m) => (
              <>
                <Card title={t('dash.cases_summary')} actions={<Link to="/lawyer/cases">{t('common.view_all')}</Link>}>
                  {Object.keys(m.byStatus).length === 0 ? <p className="muted small" style={{ margin: 0 }}>{t('cases.empty')}</p>
                    : <div className="row">{Object.entries(m.byStatus).map(([st, n]) => <span key={st} className="chip"><StatusBadge status={st} prefix="case.status" /> <strong>{n}</strong></span>)}</div>}
                </Card>
                <Card title={t('dash.outstanding_fees')} actions={<Link to="/lawyer/finance">{t('common.view_all')}</Link>}>
                  {m.balances.length === 0 ? <p className="muted small" style={{ margin: 0 }}>{t('dash.no_outstanding')}</p>
                    : <div className="list">{m.balances.map((b) => (
                      <div className="list-item clickable" key={b.client_id} onClick={() => nav(`/lawyer/clients/${b.client_id}`)}>
                        <span className="grow">{b.name}</span><strong className="num-cell">{fmtMoney(b.outstanding, lang)}</strong></div>))}</div>}
                </Card>
                <Card title={t('dash.recent_transactions')}>
                  {m.tx.length === 0 ? <p className="muted small" style={{ margin: 0 }}>{t('fin.empty')}</p>
                    : <div className="list">{m.tx.map((x) => (
                      <div className="list-item clickable" key={x.id} onClick={() => nav(`/lawyer/finance/${x.id}`)}>
                        <span className="chip">{t(`tx.kind.${x.kind}`)}</span><span className="grow small muted">{x.description || ''}</span>
                        <strong className="num-cell">{fmtMoney(x.amount, lang)}</strong></div>))}</div>}
                </Card>
                <Card title={t('dash.notifications')} actions={<Link to="/lawyer/notifications">{t('common.view_all')}</Link>}>
                  {m.notifs.length === 0 ? <p className="muted small" style={{ margin: 0 }}>{t('notif.empty')}</p>
                    : <div className="list">{m.notifs.map((n) => <div className="list-item" key={n.id}>● <span className="grow">{n.title || t(`notif.kind.${n.kind}`)}</span></div>)}</div>}
                </Card>
              </>)}
          </AsyncView>
        </div>
      </div>
      {editing && <EventModal event={editing.event} defaults={editing.defaults} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); agenda.state.reload(); upcoming.state.reload(); sum.reload(); }} />}
    </>
  );
}
