import { createRoute } from "@tanstack/react-router";
import { lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { z } from "zod";

export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("../pages/home")),
  validateSearch: z.object({
    appId: z.number().optional(),
  }),
});
