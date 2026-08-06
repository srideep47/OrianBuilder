import { createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { rootRoute } from "./root";

/**
 * The Stage's resting state.
 *
 * Renders nothing: `/` is where you are when nothing has been summoned, and the
 * Stage draws its own empty state behind the Outlet. This used to be
 * `pages/home` — a command bar, a quick-start grid, a sessions rail and an
 * advanced-settings disclosure — all of which the Presence composer and the
 * palette now do, in one place instead of four.
 *
 * The route survives because `appId` deep links point at it, and because the
 * router needs somewhere for `/` to land.
 */
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
  validateSearch: z.object({
    appId: z.number().optional(),
  }),
});
