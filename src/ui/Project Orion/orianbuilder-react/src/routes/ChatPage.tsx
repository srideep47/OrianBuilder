import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";

export function ChatPage() {
  const [draft, setDraft] = useState("");

  return (
    <div className="chat-grid">
      <aside className="chat-aside">
        <div className="eyebrow">Conversations</div>
        <Button
          variant="primary"
          style={{ justifyContent: "center", width: "100%" }}
        >
          <span>+</span> New Chat
        </Button>
        <div
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,.3)",
            textAlign: "center",
            padding: "16px 0",
          }}
        >
          No conversations yet
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-msgs">
          <div className="empty-cosmos">
            <div className="planet" aria-hidden />
            <span
              className="eyebrow"
              style={{ display: "block", marginBottom: 4 }}
            >
              Awaiting transmission
            </span>
            <h3>Start a conversation</h3>
            <p
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,.45)",
                marginTop: 6,
              }}
            >
              Ask anything — your local AI is listening across the void.
            </p>
          </div>
        </div>

        <div className="chat-input-wrap">
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <Badge>🤖 Agent</Badge>
            <Badge>Auto</Badge>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <Textarea
              placeholder="Type a message…"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ minHeight: 42, padding: "11px 14px", fontSize: 13 }}
            />
            <Button variant="primary">➤</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
