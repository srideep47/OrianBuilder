import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "./root";

/**
 * `/media-runtime` was a second path onto the exact same `pages/mediaai`
 * component as `/mediaai`, and it had its own nav item ("Media Runtime"), so the
 * Tools popover offered two entries that opened the identical screen. The
 * runtime's status and controls belong to the Create space's Studio view.
 */
export const mediaRuntimeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/media-runtime",
  beforeLoad: () => {
    throw redirect({ to: "/mediaai", replace: true });
  },
});
