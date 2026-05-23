import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import DesignStudioPage from "../pages/design-studio/index";

export const designStudioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/design-studio",
  component: DesignStudioPage,
});
