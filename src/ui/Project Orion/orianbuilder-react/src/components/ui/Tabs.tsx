import type { ReactNode } from 'react';

interface TabBarProps {
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: ReactNode }>;
  className?: string;
}

/** Underlying styled tab-bar. We use a controlled custom tab strip to match design 1:1. */
export function TabBar({ value, onValueChange, options, className }: TabBarProps) {
  return (
    <div className={`tab-bar ${className ?? ''}`}>
      {options.map((o) => (
        <button
          key={o.value}
          className={`tab ${value === o.value ? 'active' : ''}`}
          onClick={() => onValueChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Segmented control variant (settings page). */
export function Segmented({ value, onValueChange, options }: TabBarProps) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={`seg-btn ${value === o.value ? 'active' : ''}`}
          onClick={() => onValueChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
