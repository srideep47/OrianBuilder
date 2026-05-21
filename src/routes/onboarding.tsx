import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import OnboardingPage from "../pages/onboarding";

export const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});
