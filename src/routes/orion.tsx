import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const orionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orion",
  component: lazyRouteComponent(() => import("../pages/orion")),
});
