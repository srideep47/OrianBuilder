import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import InferencePage from "../pages/inference";

export const inferenceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inference",
  component: InferencePage,
});
