import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const designStudioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/design-studio",
  component: lazyRouteComponent(
    () => import("../pages/design-studio/index"),
  ),
});
