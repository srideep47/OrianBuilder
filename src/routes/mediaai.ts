import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

/**
 * The Media Studio workbench.
 *
 * This route used to render `pages/media-studio` — a 232-line landing page whose
 * body was a hero paragraph and a list of links to other routes (one of which,
 * `/3dassets`, didn't even exist; the real path is `/threedassets`). The actual
 * workbench, `pages/mediaai`, was only reachable at `/media-runtime` behind a
 * nav item labelled "Media Runtime". So the destination named "Media Studio"
 * showed shortcuts and the thing it named was hidden somewhere else.
 *
 * Now `/mediaai` is the workbench and `/media-runtime` redirects here. The
 * shortcut list is unnecessary: the space switcher does that job, with labels.
 */
export const mediaAiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mediaai",
  component: lazyRouteComponent(() => import("@/pages/mediaai")),
});
