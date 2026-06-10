import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const mediaQueueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/media-queue",
  component: lazyRouteComponent(() => import("@/pages/media-queue")),
});
