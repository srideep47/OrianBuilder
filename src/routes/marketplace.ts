import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import MarketplacePage from "../pages/marketplace";
import ModelsLibraryPage from "../pages/models-library";

export const marketplaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/marketplace",
  component: MarketplacePage,
});

export const modelsLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models",
  component: ModelsLibraryPage,
});
