import type { ReactNode } from 'react';

type Tone = 'default' | 'purple' | 'green' | 'amber' | 'red';

export function Badge({
  tone = 'default',
  children,
  className = '',
}: { tone?: Tone; children: ReactNode; className?: string }) {
  const cls = ['badge', tone !== 'default' ? tone : '', className].filter(Boolean).join(' ');
  return <span className={cls}>{children}</span>;
}
