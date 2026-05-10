import type { ReactNode } from 'react';

export function Panel({
  title,
  trailing,
  children,
  className = '',
}: { title: ReactNode; trailing?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`glass panel ${className}`}>
      <div className="panel-head">
        <h3>{title}</h3>
        {trailing ?? <span className="muted" style={{ fontSize: 11 }}>▾</span>}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}
