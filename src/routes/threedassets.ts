import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const threeDAssetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/3dassets",
  component: lazyRouteComponent(() => import("@/pages/threedassets")),
});
