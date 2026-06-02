import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const mediaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/media",
  component: lazyRouteComponent(() => import("@/pages/media")),
});
