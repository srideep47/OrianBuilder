import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import MediaAIPage from "@/pages/mediaai";

export const mediaAiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mediaai",
  component: MediaAIPage,
});
