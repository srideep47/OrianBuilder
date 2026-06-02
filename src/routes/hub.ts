import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const hubRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hub",
  component: lazyRouteComponent(() => import("../pages/hub")),
});
