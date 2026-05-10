import { useNavigate } from '@tanstack/react-router';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

interface Template {
  icon: string;
  name: string;
  badge: string;
  badgeC: 'green' | 'amber';
  desc: string;
  sel?: boolean;
}

const OFFICIAL: Template[] = [
  { icon: '⚛', name: 'React.js Template', badge: 'Official', badgeC: 'green', desc: 'Uses React, Vite, Shadcn, Tailwind & TypeScript.', sel: true },
  { icon: '▲', name: 'Next.js Template',  badge: 'Official', badgeC: 'green', desc: 'Uses Next.js, React, Shadcn, Tailwind & TypeScript.' },
];

const COMMUNITY: Template[] = [
  { icon: '🛍', name: 'Portal · Mini Store', badge: 'Experimental', badgeC: 'amber', desc: 'Uses Neon DB, Payload CMS, Next.js' },
  { icon: '⚡', name: 'SvelteKit',           badge: 'Official',     badgeC: 'green', desc: 'SvelteKit · TypeScript · Tailwind · file-based routing.' },
  { icon: '⚛', name: 'Blank React App',     badge: 'Official',     badgeC: 'green', desc: 'Start from scratch with a blank React setup.' },
  { icon: '⬡', name: 'Blank Vue App',       badge: 'Official',     badgeC: 'green', desc: 'Start from scratch with a blank Vue setup.' },
];

function TplCard({ t }: { t: Template }) {
  return (
    <div className={`glass tpl ${t.sel ? 'sel' : ''}`}>
      {t.sel && <span className="badge purple tpl-sel-badge">Selected</span>}
      <div className="tpl-preview">{t.icon}</div>
      <div className="tpl-info">
        <div className="row between" style={{ marginBottom: 5 }}>
          <div className="tpl-name">{t.name}</div>
          <Badge tone={t.badgeC}>{t.badge}</Badge>
        </div>
        <div className="tpl-desc">{t.desc}</div>
        {t.sel
          ? <Button variant="primary" style={{ width: '100%', justifyContent: 'center' }}>Create App</Button>
          : <a style={{ fontSize: 12, color: '#a88cff', cursor: 'pointer' }}>View on GitHub →</a>}
      </div>
    </div>
  );
}

export function HubPage() {
  const nav = useNavigate();

  return (
    <div className="hub-page">
      <button className="back-link" onClick={() => nav({ to: '/apps' })} type="button">← Go Back</button>
      <span className="eyebrow">⌘ Launch Hub</span>
      <h1 className="hub-title" style={{ marginTop: 6 }}>Pick your default template</h1>
      <p className="hub-sub">Choose a starting point for your new project.</p>

      <div className="hub-section-label">Official Templates</div>
      <div className="tpl-grid">
        {OFFICIAL.map((t) => <TplCard key={t.name} t={t} />)}
      </div>

      <div className="hub-section-label">Community Templates</div>
      <div className="tpl-grid">
        {COMMUNITY.map((t) => <TplCard key={t.name} t={t} />)}
      </div>
    </div>
  );
}
