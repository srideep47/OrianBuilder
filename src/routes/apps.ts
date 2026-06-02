import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const appsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps",
  component: lazyRouteComponent(() => import("../pages/apps")),
});
