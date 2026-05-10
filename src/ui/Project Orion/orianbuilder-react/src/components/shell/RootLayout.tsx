import type { ReactNode } from 'react';
import { Cosmos } from './Cosmos';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Cosmos />
      <div className="app">
        <Sidebar />
        <div className="main">
          <Topbar />
          <div className="page active">{children}</div>
        </div>
      </div>
    </>
  );
}
