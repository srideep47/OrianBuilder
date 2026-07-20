import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const mediaRuntimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/media-runtime",
  component: lazyRouteComponent(() => import("@/pages/mediaai")),
});
