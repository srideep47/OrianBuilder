import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const sharedContentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/shared",
  component: lazyRouteComponent(() => import("@/pages/shared-content")),
});
