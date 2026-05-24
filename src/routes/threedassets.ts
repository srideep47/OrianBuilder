import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import ThreeDAssetsPage from "@/pages/threedassets";

export const threeDAssetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/3dassets",
  component: ThreeDAssetsPage,
});
