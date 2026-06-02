import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const networkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/network",
  component: lazyRouteComponent(() => import("../pages/network")),
});
