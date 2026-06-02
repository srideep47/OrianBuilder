import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const inferenceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inference",
  component: lazyRouteComponent(() => import("../pages/inference")),
});
