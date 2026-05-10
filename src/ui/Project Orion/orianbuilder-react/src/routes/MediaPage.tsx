import { useAtom } from 'jotai';
import { modalityAtom, mediaPromptAtom, type Modality } from '@/lib/atoms';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';

const MODS: { id: Modality; icon: string; name: string; sub: string }[] = [
  { id: 'text',  icon: '◎', name: 'Text',  sub: 'Phi-3 mini' },
  { id: 'image', icon: '⊞', name: 'Image', sub: 'SD 1.5' },
  { id: 'audio', icon: '♪', name: 'Audio', sub: 'SpeechT5' },
  { id: 'video', icon: '▶', name: 'Video', sub: 'MS-1.7B' },
];

export function MediaPage() {
  const [modality, setModality] = useAtom(modalityAtom);
  const [prompt, setPrompt] = useAtom(mediaPromptAtom);

  const titles: Record<Modality, string> = {
    text: 'Text Generation',
    image: 'Image Generation',
    audio: 'Audio Generation',
    video: 'Video Generation',
  };
  const descs: Record<Modality, string> = {
    text: 'Generate text using local Phi-3 model',
    image: 'Generate images using local Stable Diffusion 1.5',
    audio: 'Generate speech using SpeechT5 + HiFi-GAN',
    video: 'Generate short videos using Text-to-Video MS-1.7B',
  };

  return (
    <div className="media-page">
      <div className="media-hero">
        <div>
          <span className="eyebrow">✦ Generation Studio</span>
          <h1 className="page-title" style={{ marginTop: 6 }}>Media AI</h1>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Generate text, images, audio, and video using local AI models
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="red">⊘ Backend Offline</Badge>
          <Button size="sm">⚙</Button>
        </div>
      </div>

      <div className="modality-tabs">
        {MODS.map((m) => (
          <button
            key={m.id}
            className={`mod-tab ${modality === m.id ? 'active' : ''}`}
            onClick={() => setModality(m.id)}
            type="button"
          >
            <span className="mi">{m.icon}</span>
            <div className="mn">{m.name}</div>
            <div className="ms">{m.sub}</div>
          </button>
        ))}
      </div>

      <div className="studio">
        <div className="glass studio-card">
          <h3>{titles[modality]}</h3>
          <div className="desc">{descs[modality]}</div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Prompt</div>
          <Textarea
            placeholder="Enter your text prompt here…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <Button
            variant="primary"
            style={{ width: '100%', justifyContent: 'center', marginTop: 12, padding: 10, opacity: 0.6 }}
          >
            ✦ Generate {modality === 'text' ? 'Text' : modality === 'image' ? 'Image' : modality === 'audio' ? 'Audio' : 'Video'}
          </Button>
        </div>

        <div className="glass-soft guide">
          <h4>Getting Started</h4>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>1. Start the Backend</div>
          <div className="code-block">cd mediaai-backend &amp;&amp; pip install -r requirements.txt</div>
          <div style={{ fontSize: 12, fontWeight: 500, margin: '14px 0 6px' }}>2. Available Models</div>
          <ul>
            <li>Text · Phi-3-mini-4k-instruct (GGUF)</li>
            <li>Image · Stable Diffusion 1.5 (ONNX)</li>
            <li>Audio · SpeechT5 TTS + HiFi-GAN</li>
            <li>Video · Text-to-Video MS-1.7B</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
