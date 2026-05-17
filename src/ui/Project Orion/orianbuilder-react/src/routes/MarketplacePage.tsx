import { useState } from "react";
import { useAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { marketSearchAtom, marketTagAtom } from "@/lib/atoms";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { TabBar } from "@/components/ui/Tabs";

interface Model {
  org: string;
  name: string;
  dl: string;
  likes: string;
  date: string;
  tags: string[];
}

const FALLBACK_MODELS: Model[] = [
  {
    org: "mixedbread-ai",
    name: "mxbai-embed-large-v1",
    dl: "4.5M",
    likes: "793",
    date: "1/23/26",
    tags: ["onnx", "safetensors"],
  },
  {
    org: "unsloth",
    name: "gemma-4-26B-A4B-it-GGUF",
    dl: "3.3M",
    likes: "680",
    date: "5/4/26",
    tags: ["gguf", "gemma4"],
  },
  {
    org: "AndyCurrent",
    name: "Gemma-3-1B-Heretic-Uncensored",
    dl: "2.8M",
    likes: "20",
    date: "2/18/26",
    tags: ["gguf", "reasoning"],
  },
  {
    org: "unsloth",
    name: "Qwen3.6-35B-A3B-GGUF",
    dl: "2.4M",
    likes: "951",
    date: "4/20/26",
    tags: ["gguf", "qwen"],
  },
  {
    org: "lmg-anon",
    name: "vntl-llama3-8b-v2-gguf",
    dl: "2.0M",
    likes: "14",
    date: "1/2/25",
    tags: ["gguf", "translation"],
  },
  {
    org: "unsloth",
    name: "gemma-4-31B-it-GGUF",
    dl: "1.7M",
    likes: "399",
    date: "5/4/26",
    tags: ["gguf", "gemma4"],
  },
  {
    org: "unsloth",
    name: "gemma-4-E4B-it-GGUF",
    dl: "1.5M",
    likes: "375",
    date: "5/4/26",
    tags: ["gguf", "gemma4"],
  },
  {
    org: "lmstudio-community",
    name: "gemma-4-E4B-it-GGUF",
    dl: "1.4M",
    likes: "34",
    date: "4/13/26",
    tags: ["gguf"],
  },
  {
    org: "unsloth",
    name: "Qwen3.6-27B-GGUF",
    dl: "1.3M",
    likes: "606",
    date: "4/22/26",
    tags: ["gguf", "qwen"],
  },
];

const TAGS = [
  "Qwen 3",
  "Llama 3.x",
  "Mistral",
  "Gemma",
  "DeepSeek",
  "Phi",
] as const;
const DL_TABS = [
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

export function MarketplacePage() {
  const [search, setSearch] = useAtom(marketSearchAtom);
  const [tag, setTag] = useAtom(marketTagAtom);
  const [dlTab, setDlTab] = useState("active");

  const { data: models = FALLBACK_MODELS } = useQuery({
    queryKey: ["hf-models", tag, search],
    queryFn: async () => FALLBACK_MODELS,
    initialData: FALLBACK_MODELS,
  });

  return (
    <div className="market-page">
      <div className="market-l">
        <div className="market-hero">
          <span className="eyebrow">⊕ Discover</span>
          <h1 className="page-title" style={{ marginTop: 6 }}>
            Model Marketplace
          </h1>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Browse Hugging Face GGUF models for your local engine
          </div>
        </div>

        <div className="search-pill">
          <span className="si">⌕</span>
          <input
            className="input"
            placeholder="Search GGUF models… (qwen3, llama, mistral)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="tag-row">
          {TAGS.map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tag === t ? "primary" : "default"}
              onClick={() => setTag(t)}
            >
              {t}
            </Button>
          ))}
        </div>

        <div className="model-grid">
          {models.map((m, i) => (
            <div key={`${m.org}/${m.name}/${i}`} className="glass mc">
              <div className="mc-org">{m.org}</div>
              <div className="mc-name">{m.name}</div>
              <div className="mc-meta">
                <span>↓ {m.dl}</span>
                <span>♡ {m.likes}</span>
                <span>{m.date}</span>
              </div>
              <div className="mc-tags">
                {m.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-deep market-r">
        <div className="dl-pane">
          <div className="dl-head">
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>↓</span> Downloads
            </div>
            <TabBar value={dlTab} onValueChange={setDlTab} options={DL_TABS} />
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              textAlign: "center",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 28, opacity: 0.5 }}>⊙</div>
            <div
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,.45)",
                maxWidth: 180,
                lineHeight: 1.5,
              }}
            >
              Pick a model on the left to see download options.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
