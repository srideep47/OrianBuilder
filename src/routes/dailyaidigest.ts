import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import DailyAIDigestPage from "@/pages/dailyaidigest";

export const dailyAiDigestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dailyaidigest",
  component: DailyAIDigestPage,
});
