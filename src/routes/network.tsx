import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import NetworkPage from "../pages/network";

export const networkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/network",
  component: NetworkPage,
});
