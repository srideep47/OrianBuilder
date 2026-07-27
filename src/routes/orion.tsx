import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "./root";

/**
 * `/orion` rendered a "Control Center" page showing the same command bar and
 * sessions list as `/`, reached from its own nav item — two destinations, one
 * job. The command surface at `/` absorbed the panels that were genuinely
 * unique to it (setup, model config, storage, workflows), so this path now just
 * resolves there.
 */
export const orionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/orion",
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
