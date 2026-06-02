import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const marketplaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/marketplace",
  component: lazyRouteComponent(() => import("../pages/marketplace")),
});

export const modelsLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models",
  component: lazyRouteComponent(() => import("../pages/models-library")),
});
