import { Link } from 'react-router-dom';
import { useI18n } from '../../lib/i18n.jsx';
import { PageHead } from '../../components/ui.jsx';

/** The two ways a client can ask: the AI assistant (instant) or a specialist lawyer (reviewed reply). */
export default function Ask() {
  const { t } = useI18n();
  const options = [
    { to: '/client/assistant', glyph: '🤖', title: t('ask.ai_title'), body: t('ask.ai_body'), points: ['ask.ai_p1', 'ask.ai_p2', 'ask.ai_p3'], cta: t('ask.ai_cta'), tone: 'ai' },
    { to: '/client/new', glyph: '⚖️', title: t('ask.lawyer_title'), body: t('ask.lawyer_body'), points: ['ask.lawyer_p1', 'ask.lawyer_p2', 'ask.lawyer_p3'], cta: t('ask.lawyer_cta'), tone: 'lawyer' },
  ];
  return (
    <>
      <PageHead title={t('ask.title')} subtitle={t('ask.subtitle')} />
      <div className="ask-options">
        {options.map((o) => (
          <Link key={o.to} to={o.to} className={`ask-option ${o.tone}`}>
            <span className="ask-glyph" aria-hidden="true">{o.glyph}</span>
            <h2>{o.title}</h2>
            <p className="muted">{o.body}</p>
            <ul>{o.points.map((p) => <li key={p}>✓ {t(p)}</li>)}</ul>
            <span className="btn btn-primary">{o.cta}</span>
          </Link>))}
      </div>
      <p className="small muted" style={{ textAlign: 'center', marginTop: 16 }}>
        {t('ask.directory_hint')} <Link to="/client/directory">{t('nav.directory')}</Link>
      </p>
    </>);
}
