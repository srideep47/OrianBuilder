import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

/**
 * The Game space — manual Godot control plus the setup for the automated
 * game-development pipeline. Lazy because it pulls in the viewport, scene tree
 * and inspector, none of which anyone needs until they open it.
 */
export const gameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/game",
  component: lazyRouteComponent(() => import("@/pages/game")),
});
