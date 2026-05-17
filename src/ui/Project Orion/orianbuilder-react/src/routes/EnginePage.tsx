import { useAtom } from "jotai";
import {
  runtimeAtom,
  vramBudgetAtom,
  contextSizeAtom,
  exactContextAtom,
  type Runtime,
} from "@/lib/atoms";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Panel } from "@/components/ui/Panel";

const RUNTIMES: { id: Runtime; name: string; desc: string; icon: string }[] = [
  {
    id: "llamacpp",
    icon: "⚡",
    name: "llama.cpp CUDA",
    desc: "GGUF models with GPU layer offload, Flash Attention, and CPU fallback.",
  },
  {
    id: "tensorrt",
    icon: "▣",
    name: "Native TensorRT",
    desc: "Windows runner for compiled TensorRT engines. No WSL.",
  },
];

export function EnginePage() {
  const [runtime, setRuntime] = useAtom(runtimeAtom);
  const [vram, setVram] = useAtom(vramBudgetAtom);
  const [ctx, setCtx] = useAtom(contextSizeAtom);
  const [exact, setExact] = useAtom(exactContextAtom);

  return (
    <div className="cockpit">
      {/* ── Left column ── */}
      <div className="cockpit-l">
        <div className="eng-hero">
          <div>
            <span className="eyebrow">⚡ Inference Telemetry</span>
            <h1 className="page-title" style={{ marginTop: 6 }}>
              Inference Engine
            </h1>
            <div className="sub">
              node-llama-cpp · CUDA Ampere · Embedded tensor inference
            </div>
          </div>
          <Badge tone="amber">No model loaded</Badge>
        </div>

        <Panel title="◉ Runtime">
          <div className="runtime-grid">
            {RUNTIMES.map((r) => (
              <button
                key={r.id}
                className={`runtime-card ${runtime === r.id ? "sel" : ""}`}
                onClick={() => setRuntime(r.id)}
                type="button"
              >
                <div className="rt-name">
                  {r.icon} {r.name}
                </div>
                <div className="rt-desc">{r.desc}</div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="◫ Model">
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            GGUF File
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <Input
              placeholder="No file selected"
              readOnly
              style={{ flex: 1 }}
            />
            <Button size="sm">📁 Browse</Button>
            <Button size="sm">⟳</Button>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "rgba(168,140,255,.7)",
              marginBottom: 14,
            }}
          >
            Pick from your downloaded library, or browse to any GGUF.
          </div>
          <Button
            variant="primary"
            style={{
              width: "100%",
              justifyContent: "center",
              padding: 9,
              opacity: 0.55,
            }}
          >
            ⚡ Load Model
          </Button>
        </Panel>

        <Panel title="≋ Memory & Compute">
          <div className="row between" style={{ marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>
                ⚡ VRAM Budget
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>
                Use 5.5 GB · keep 0.5 GB free
              </div>
            </div>
            <span className="mono" style={{ fontSize: 12 }}>
              {vram} MB
            </span>
          </div>
          <input
            type="range"
            className="slider"
            min={256}
            max={2048}
            value={vram}
            onChange={(e) => setVram(+e.target.value)}
          />
          <div className="slider-labels">
            <span>256 MB</span>
            <span>512 MB</span>
            <span>2 GB</span>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              color: "rgba(255,255,255,.45)",
              margin: "10px 0 14px",
            }}
          >
            <span>Balanced</span>
            <span>Fit Context</span>
            <span>Max GPU</span>
          </div>

          <hr className="divider" />

          <div className="row between" style={{ marginBottom: 4 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>
                Exact Context Allocation
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,.4)",
                  maxWidth: 380,
                  marginTop: 2,
                }}
              >
                Requests the selected context exactly. If it cannot fit, the
                loader reduces GPU layers.
              </div>
            </div>
            <Switch
              checked={exact}
              onCheckedChange={setExact}
              aria-label="Exact context allocation"
            />
          </div>

          <hr className="divider" />

          <div className="row between" style={{ marginBottom: 6 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 500 }}>
                Context Size
              </span>
              <Badge tone="amber">too small for app building</Badge>
            </div>
            <Badge>{ctx}K</Badge>
          </div>
          <div className="warn-box" style={{ marginBottom: 10 }}>
            ⚠ App building needs ≥ 32K context. Below 32K the prompt gets
            truncated.
          </div>
          <input
            type="range"
            className="slider"
            min={2}
            max={128}
            value={ctx}
            onChange={(e) => setCtx(+e.target.value)}
          />
          <div className="slider-labels">
            <span>2K</span>
            <span>VRAM 9K</span>
            <span>Max 128K</span>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <Button
              size="sm"
              style={{ flex: 1, justifyContent: "center" }}
              onClick={() => setCtx(2)}
            >
              Min
            </Button>
            <Button
              size="sm"
              variant="primary"
              style={{ flex: 1, justifyContent: "center" }}
              onClick={() => setCtx(128)}
            >
              Model Max
            </Button>
          </div>
        </Panel>
      </div>

      {/* ── Right column ── */}
      <div className="cockpit-r">
        <Panel title="⊞ Hardware" className="!mb-0">
          <div className="row between" style={{ marginBottom: 5 }}>
            <span className="eyebrow">VRAM</span>
            <span className="mono" style={{ fontSize: 11 }}>
              0.0 / 6.0 GB
            </span>
          </div>
          <div className="row between" style={{ marginBottom: 12 }}>
            <span className="eyebrow">Spill</span>
            <span className="mono" style={{ fontSize: 11 }}>
              0 MB
            </span>
          </div>
          <div className="tel-grid">
            <div className="tel">
              <div className="tl">GPU</div>
              <div className="tv">
                0<span className="tu">%</span>
              </div>
            </div>
            <div className="tel">
              <div className="tl">Temp</div>
              <div className="tv">
                46<span className="tu">°C</span>
              </div>
            </div>
            <div className="tel">
              <div className="tl">Power</div>
              <div className="tv">
                12<span className="tu">W</span>
              </div>
            </div>
            <div className="tel">
              <div className="tl">Clock</div>
              <div className="tv" style={{ fontSize: 14 }}>
                210<span className="tu">MHz</span>
              </div>
            </div>
          </div>
          <hr className="divider" />
          <div className="col">
            <div className="tl-row">
              <span className="k">Backend</span>
              <span>Idle</span>
            </div>
            <div className="tl-row">
              <span className="k">Tensor Cores</span>
              <Badge tone="amber">Ready</Badge>
            </div>
            <div className="tl-row">
              <span className="k">GPU</span>
              <span style={{ fontSize: 10 }}>RTX 3060</span>
            </div>
            <div className="tl-row">
              <span className="k">VRAM</span>
              <span>6.0 GB</span>
            </div>
            <div className="tl-row">
              <span className="k">Compute</span>
              <span>CC 8.6</span>
            </div>
          </div>
        </Panel>

        <Panel title="⌇ Inference Monitor" className="!mb-0">
          <div
            className="glass-soft"
            style={{ borderRadius: 8, padding: 10, marginBottom: 12 }}
          >
            <div style={{ fontSize: 12, fontWeight: 500 }}>Idle</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>
              No backend active
            </div>
          </div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            ⚡ Speed (tok/s)
          </div>
          <div className="speeds">
            {["Live", "Decode", "Prefill", "Peak"].map((l) => (
              <div key={l} className="speed">
                <div className="speed-bar" />
                <span className="speed-lab">{l}</span>
              </div>
            ))}
          </div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Session
          </div>
          <div className="col">
            <div className="tl-row">
              <span className="k">Prompt</span>
              <span className="mono">0</span>
            </div>
            <div className="tl-row">
              <span className="k">Output</span>
              <span className="mono">0</span>
            </div>
            <div className="tl-row">
              <span className="k">Duration</span>
              <span className="mono">0ms</span>
            </div>
            <div className="tl-row">
              <span className="k">All-time</span>
              <span className="mono">0</span>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
