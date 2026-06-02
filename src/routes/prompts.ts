import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const promptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/prompts",
  component: lazyRouteComponent(() => import("@/pages/library")),
});
