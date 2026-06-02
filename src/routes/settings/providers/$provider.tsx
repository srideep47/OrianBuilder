import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "@/routes/root";
import { lazy } from "react";

// Lazy-load the heavy provider settings component
const ProviderSettingsPageLazy = lazy(() =>
  import("@/components/settings/ProviderSettingsPage").then((m) => ({
    default: m.ProviderSettingsPage,
  })),
);

interface ProviderSettingsParams {
  provider: string;
}

export const providerSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/providers/$provider",
  params: {
    parse: (params: { provider: string }): ProviderSettingsParams => ({
      provider: params.provider,
    }),
  },
  component: function ProviderSettingsRouteComponent() {
    const { provider } = providerSettingsRoute.useParams();

    return <ProviderSettingsPageLazy provider={provider} />;
  },
});
