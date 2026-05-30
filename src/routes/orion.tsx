import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import OrionPage from "../pages/orion";

export const orionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orion",
  component: OrionPage,
});
