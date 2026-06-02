import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const mediaAiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mediaai",
  component: lazyRouteComponent(() => import("@/pages/mediaai")),
});
