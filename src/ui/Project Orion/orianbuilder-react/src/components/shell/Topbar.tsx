import { useRouterState } from '@tanstack/react-router';

export function Topbar() {
  const { location } = useRouterState();
  const ctx = location.pathname.replace('/', '') || 'apps';

  return (
    <div className="topbar">
      <span className="app-ctx">
        <span className="dot" />
        OrianBuilder · {ctx}
      </span>
      <div className="win-btns">
        <button className="win-btn" aria-label="Minimize">—</button>
        <button className="win-btn" aria-label="Maximize">⤢</button>
        <button className="win-btn close" aria-label="Close">✕</button>
      </div>
    </div>
  );
}
