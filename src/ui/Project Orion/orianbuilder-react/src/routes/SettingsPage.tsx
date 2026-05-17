import { useAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import {
  themeAtom,
  languageAtom,
  zoomAtom,
  autoUpdateAtom,
  releaseChannelAtom,
  settingsSectionAtom,
  type Theme,
} from "@/lib/atoms";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Segmented } from "@/components/ui/Tabs";

const SECTIONS = [
  { id: "general", label: "⚙ General" },
  { id: "workflow", label: "⟳ Workflow" },
  { id: "ai", label: "✦ AI" },
  { id: "providers", label: "▣ Model Providers" },
  { id: "telemetry", label: "📊 Telemetry" },
  { id: "integrations", label: "🔌 Integrations" },
  { id: "permissions", label: "🔐 Permissions" },
  { id: "tools", label: "🛠 Tools (MCP)" },
  { id: "experiments", label: "⚗ Experiments" },
];

export function SettingsPage() {
  const nav = useNavigate();
  const [section, setSection] = useAtom(settingsSectionAtom);
  const [theme, setTheme] = useAtom(themeAtom);
  const [lang, setLang] = useAtom(languageAtom);
  const [zoom, setZoom] = useAtom(zoomAtom);
  const [autoUpdate, setAutoUpdate] = useAtom(autoUpdateAtom);
  const [channel, setChannel] = useAtom(releaseChannelAtom);

  return (
    <div className="settings-shell">
      <aside className="settings-aside">
        <div className="head">⊙ Settings</div>
        <div className="search-mini">
          <Input
            placeholder="Search…"
            style={{ fontSize: 11, padding: "6px 10px" }}
          />
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`set-item ${section === s.id ? "active" : ""}`}
            onClick={() => setSection(s.id)}
            type="button"
          >
            {s.label}
          </button>
        ))}
        <button
          className="set-item danger"
          type="button"
          onClick={() => setSection("danger")}
        >
          ⚠ Danger Zone
        </button>
      </aside>

      <div className="settings-content">
        <button
          className="back-link"
          onClick={() => nav({ to: "/apps" })}
          type="button"
        >
          ← Go Back
        </button>

        <div className="glass set-section">
          <h2>⊙ General Settings</h2>

          <div className="set-row">
            <div className="lbl">Theme</div>
            <div className="ctl">
              <Segmented
                value={theme}
                onValueChange={(v) => setTheme(v as Theme)}
                options={[
                  { value: "system", label: "System" },
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </div>
          </div>

          <div className="set-row">
            <div className="lbl">Language</div>
            <div className="desc">Choose your preferred display language.</div>
            <div className="ctl">
              <Select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                style={{ width: 180 }}
              >
                <option value="en">en</option>
                <option value="fr">fr</option>
                <option value="de">de</option>
              </Select>
            </div>
          </div>

          <div className="set-row">
            <div className="lbl">Zoom level</div>
            <div className="desc">
              Adjusts the zoom level to make content easier to read.
            </div>
            <div className="ctl">
              <Select
                value={zoom}
                onChange={(e) => setZoom(+e.target.value)}
                style={{ width: 120 }}
              >
                <option value={100}>100</option>
                <option value={110}>110</option>
                <option value={125}>125</option>
              </Select>
            </div>
          </div>

          <div className="set-row">
            <div className="row between">
              <div>
                <div className="lbl">Auto-update app</div>
                <div className="desc" style={{ color: "rgba(168,140,255,.7)" }}>
                  Automatically update when new versions are available.
                </div>
              </div>
              <Switch
                checked={autoUpdate}
                onCheckedChange={setAutoUpdate}
                aria-label="Auto-update app"
              />
            </div>
          </div>

          <div className="set-row">
            <div className="row" style={{ gap: 14 }}>
              <div style={{ flex: 1 }}>
                <div className="lbl">Release channel</div>
                <div className="desc">
                  Controls which update channel the app uses.
                </div>
              </div>
              <Select
                value={channel}
                onChange={(e) =>
                  setChannel(e.target.value as "stable" | "beta")
                }
                style={{ width: 120 }}
              >
                <option value="stable">stable</option>
                <option value="beta">beta</option>
              </Select>
            </div>
          </div>

          <div className="set-row">
            <div className="lbl" style={{ marginBottom: 8 }}>
              Node.js Path
            </div>
            <div
              className="glass-soft"
              style={{
                borderRadius: 8,
                padding: "10px 12px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div className="eyebrow">System PATH</div>
                <div className="mono" style={{ fontSize: 11, marginTop: 3 }}>
                  C:\Program Files\nodejs\node.exe
                </div>
              </div>
              <Badge tone="green">✓ v24.0.2</Badge>
            </div>
          </div>

          <div className="set-row">
            <div className="lbl" style={{ marginBottom: 8 }}>
              Apps Folder
            </div>
            <div
              className="glass-soft"
              style={{ borderRadius: 8, padding: "10px 12px" }}
            >
              <div className="eyebrow">Default Folder</div>
              <div className="mono" style={{ fontSize: 11, marginTop: 3 }}>
                C:\Users\ankit\orianbuilder-apps
              </div>
            </div>
            <div
              style={{
                fontSize: 11,
                color: "rgba(168,140,255,.65)",
                marginTop: 6,
              }}
            >
              App Version <Badge className="mono">0.44.0</Badge>
            </div>
          </div>
        </div>

        <div className="glass set-section">
          <h2>⟳ Workflow</h2>
          <div className="set-row">
            <div className="row between">
              <div>
                <div className="lbl">Default Chat Mode</div>
                <div className="desc">
                  Controls the default chat mode when opening a new chat.
                </div>
              </div>
              <Select style={{ width: 130 }} defaultValue="agent">
                <option value="agent">Agent</option>
                <option value="chat">Chat</option>
              </Select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
