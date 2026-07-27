import {
  createRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { rootRoute } from "./root";

/**
 * The template picker. It used to live at `/hub`, which collided with what
 * "Hub" means everywhere else in the product (peers and shared work, as in
 * OrionAndroid's Hub tab). The page is a list of project starting points, so
 * `/templates` is what it is.
 */
export const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  component: lazyRouteComponent(() => import("@/pages/hub")),
});

/** Old path, kept so existing links and the Hub nav item both resolve. */
export const hubRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hub",
  beforeLoad: () => {
    throw redirect({ to: "/network", replace: true });
  },
});
