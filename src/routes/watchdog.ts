import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const watchdogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/watchdog",
  component: lazyRouteComponent(() => import("../pages/watchdog")),
});
