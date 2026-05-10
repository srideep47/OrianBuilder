import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
  Outlet,
  redirect,
} from '@tanstack/react-router';

import { RootLayout } from './components/shell/RootLayout';
import { AppsPage } from './routes/AppsPage';
import { ChatPage } from './routes/ChatPage';
import { EnginePage } from './routes/EnginePage';
import { ModelsPage } from './routes/ModelsPage';
import { MarketplacePage } from './routes/MarketplacePage';
import { MediaPage } from './routes/MediaPage';
import { SettingsPage } from './routes/SettingsPage';
import { LibraryPage } from './routes/LibraryPage';
import { HubPage } from './routes/HubPage';

const rootRoute = createRootRoute({
  component: () => (
    <RootLayout>
      <Outlet />
    </RootLayout>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => { throw redirect({ to: '/apps' }); },
});

const appsRoute        = createRoute({ getParentRoute: () => rootRoute, path: '/apps',        component: AppsPage });
const chatRoute        = createRoute({ getParentRoute: () => rootRoute, path: '/chat',        component: ChatPage });
const engineRoute      = createRoute({ getParentRoute: () => rootRoute, path: '/engine',      component: EnginePage });
const modelsRoute      = createRoute({ getParentRoute: () => rootRoute, path: '/models',      component: ModelsPage });
const marketplaceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/marketplace', component: MarketplacePage });
const mediaRoute       = createRoute({ getParentRoute: () => rootRoute, path: '/media',       component: MediaPage });
const settingsRoute    = createRoute({ getParentRoute: () => rootRoute, path: '/settings',    component: SettingsPage });
const libraryRoute     = createRoute({ getParentRoute: () => rootRoute, path: '/library',     component: LibraryPage });
const hubRoute         = createRoute({ getParentRoute: () => rootRoute, path: '/hub',         component: HubPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  appsRoute,
  chatRoute,
  engineRoute,
  modelsRoute,
  marketplaceRoute,
  mediaRoute,
  settingsRoute,
  libraryRoute,
  hubRoute,
]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/apps'] }),
  defaultPreload: 'intent',
});
