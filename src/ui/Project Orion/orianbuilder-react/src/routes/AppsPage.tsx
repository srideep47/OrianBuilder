import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

const QUICK = [
  '📋 TODO list app',
  '🏠 Landing Page',
  '📝 Sign Up Form',
  '🔄 More ideas',
];

export function AppsPage() {
  const [prompt, setPrompt] = useState('');

  return (
    <div className="apps-stage">
      <div className="orbital-rings" aria-hidden />
      <div className="orbital">
        <div className="apps-hero">
          <span className="eyebrow">Mission Control · Setup</span>
          <h1>Setup OrianBuilder</h1>
        </div>

        <div className="glass video-strip">
          <div className="video-thumb" aria-hidden />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Get started in 3 minutes</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.45)', marginTop: 2 }}>
              Start building your app for free
            </div>
          </div>
        </div>

        <div className="glass step">
          <div className="step-head">
            <span className="step-num done">✓</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>Install Node.js · App Runtime</span>
            <Badge tone="green">v24.0.2</Badge>
            <span className="muted" style={{ fontSize: 11 }}>▾</span>
          </div>
        </div>

        <div className="glass step">
          <div className="step-head">
            <span className="step-num todo">2</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>Setup AI Access</span>
            <span className="muted" style={{ fontSize: 11 }}>▴</span>
          </div>
          <div className="step-body">
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', marginTop: 12 }}>
              Pick a provider — both have a generous free tier.
            </p>
            <div className="api-row">
              <div className="glass-soft api-card">
                <span style={{ fontSize: 14 }}>G</span>
                <span style={{ flex: 1, fontSize: 12 }}>Google Gemini API</span>
                <Badge tone="green">Free</Badge>
              </div>
              <div className="glass-soft api-card">
                <span style={{ fontSize: 14 }}>⟳</span>
                <span style={{ flex: 1, fontSize: 12 }}>OpenRouter API</span>
                <Badge tone="green">Free</Badge>
              </div>
            </div>
            <div className="glass-soft api-card" style={{ marginTop: 8 }}>
              <span style={{ fontSize: 14 }}>⊕</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12 }}>Other providers</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,.4)' }}>
                  OpenAI · Anthropic · Mistral
                </div>
              </div>
              <span className="muted">›</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', margin: '14px 0' }}>
          <Button variant="primary"><span>↑</span> Import App</Button>
        </div>

        <div className="glass" style={{ borderRadius: 12, padding: 14 }}>
          <div className="prompt-block" style={{ marginTop: 0 }}>
            <input
              className="prompt-input"
              placeholder="Ask OrianBuilder to build a landing page…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="prompt-actions">
              <button className="icon-btn" aria-label="Voice">🎤</button>
              <button className="icon-btn send" aria-label="Send">➤</button>
            </div>
          </div>
          <div className="row" style={{ fontSize: 10, color: 'rgba(255,255,255,.4)', gap: 8, marginTop: 10 }}>
            <Badge>🤖 Agent</Badge>
            <Badge>Auto</Badge>
            <Badge tone="purple">⭐ Pro</Badge>
          </div>
          <div className="chip-row">
            {QUICK.map((q) => (
              <span key={q} className="chip">{q}</span>
            ))}
          </div>
        </div>

        <div className="promo">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#5fdfa3', fontWeight: 500 }}>Up to 3× cheaper</div>
            <div style={{ fontSize: 10, color: 'rgba(95,223,163,.65)' }}>by using Smart Context</div>
          </div>
          <Button
            size="sm"
            style={{
              background: 'rgba(60,200,140,.18)',
              borderColor: 'rgba(60,200,140,.35)',
              color: '#5fdfa3',
            }}
          >
            Get Pro →
          </Button>
        </div>
      </div>
    </div>
  );
}
