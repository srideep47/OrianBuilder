/**
 * The surface list, fetched once from the capability graph.
 *
 * Deliberately not a second hard-coded list in the renderer. The palette, the
 * Stage and Marta must agree on what exists, and the only way to guarantee that
 * is for all three to read the same source — the graph built in main from the
 * app's real contracts.
 */

import { useQuery } from "@tanstack/react-query";

import { ipc, type MartaSurface } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

export interface SurfaceCatalog {
  surfaces: MartaSurface[];
  byId: Map<string, MartaSurface>;
  byRoute: Map<string, MartaSurface>;
  isLoading: boolean;
}

const EMPTY: MartaSurface[] = [];

export function useSurfaceCatalog(): SurfaceCatalog {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.marta.graph(),
    queryFn: () => ipc.marta.getGraph(),
    // The graph is derived from module constants in main; it cannot change
    // while the app runs, so refetching it is pure waste.
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const surfaces = data?.surfaces ?? EMPTY;
  return {
    surfaces,
    byId: new Map(surfaces.map((s) => [s.id, s])),
    byRoute: new Map(surfaces.map((s) => [s.route, s])),
    isLoading,
  };
}
