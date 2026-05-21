import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import WatchdogPage from "../pages/watchdog";

export const watchdogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/watchdog",
  component: WatchdogPage,
});
