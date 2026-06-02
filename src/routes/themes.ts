import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const themesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/themes",
  component: lazyRouteComponent(() => import("@/pages/themes")),
});
