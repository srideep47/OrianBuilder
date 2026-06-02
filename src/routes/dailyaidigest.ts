import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const dailyAiDigestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dailyaidigest",
  component: lazyRouteComponent(() => import("@/pages/dailyaidigest")),
});
