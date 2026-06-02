import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { z } from "zod";

export const appDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app-details",
  component: lazyRouteComponent(() => import("../pages/app-details")),
  validateSearch: z.object({
    appId: z.number().optional(),
    provider: z.enum(["neon", "supabase"]).optional(),
  }),
});
