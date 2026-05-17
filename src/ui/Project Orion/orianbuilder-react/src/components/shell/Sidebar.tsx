import { Link, useRouterState } from "@tanstack/react-router";

const NAV = [
  { to: "/apps", icon: "⊞", label: "Apps" },
  { to: "/chat", icon: "◎", label: "Chat" },
  { to: "/engine", icon: "⚡", label: "Engine" },
  { to: "/models", icon: "◫", label: "Models" },
  { to: "/marketplace", icon: "⊕", label: "Marketplace" },
  { to: "/media", icon: "✦", label: "Media AI" },
  { to: "/settings", icon: "⊙", label: "Settings" },
  { to: "/library", icon: "⊟", label: "Library" },
  { to: "/hub", icon: "⌘", label: "Hub" },
] as const;

export function Sidebar() {
  const { location } = useRouterState();
  const path = location.pathname;

  return (
    <aside className="sidebar">
      <div className="sb-logo">
        <div className="orb" />
        <span className="brand">OrianBuilder</span>
      </div>
      <nav className="nav-list">
        {NAV.map((item) => {
          const active = path.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`nav-item ${active ? "active" : ""}`}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
