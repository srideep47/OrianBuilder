import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/Button';

export function ModelsPage() {
  const nav = useNavigate();

  return (
    <div className="models-page">
      <div className="models-hero">
        <div>
          <span className="eyebrow">⊙ Local Constellation</span>
          <h1 className="page-title" style={{ marginTop: 6 }}>Models Library</h1>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Downloaded GGUF models · load any of them into the engine
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button onClick={() => nav({ to: '/marketplace' })}>⊞ Marketplace</Button>
          <Button onClick={() => nav({ to: '/engine' })}>⚡ Engine Settings</Button>
        </div>
      </div>

      <div className="stat-trio">
        <div className="glass stat-card">
          <div className="eyebrow">Models on Disk</div>
          <div className="big">0</div>
          <div className="small">Local GGUF files</div>
        </div>
        <div className="glass stat-card">
          <div className="eyebrow">Total Size</div>
          <div className="big">—</div>
          <div className="small">Reserved storage</div>
        </div>
        <div className="glass stat-card">
          <div className="eyebrow">Storage Path</div>
          <div className="path" style={{ marginTop: 8 }}>
            C:\Users\ankit\AppData\Roaming\OrianBuilder\models
          </div>
        </div>
      </div>

      <div className="glass empty-zone">
        <div className="galaxy-mini" aria-hidden />
        <h3>No models orbiting yet</h3>
        <p>Browse the Marketplace to download GGUF models from Hugging Face.</p>
        <Button variant="primary" onClick={() => nav({ to: '/marketplace' })}>⊕ Open Marketplace</Button>
      </div>
    </div>
  );
}
