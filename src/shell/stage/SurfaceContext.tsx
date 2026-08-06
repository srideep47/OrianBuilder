/**
 * Which surface the subtree is rendering.
 *
 * Needed because a page can no longer work out what it is from the router: the
 * secondary pane renders outside the router entirely, and two panes are showing
 * two different surfaces at the same location. `SpaceHeader` reads this to fall
 * back to the surface's own title and summary — which come from the capability
 * graph, so the header, the palette and Marta all name a surface the same way.
 */

import { createContext, useContext, type ReactNode } from "react";

const SurfaceIdContext = createContext<string | null>(null);

export function SurfaceScope({
  surfaceId,
  children,
}: {
  surfaceId: string | null;
  children: ReactNode;
}) {
  return (
    <SurfaceIdContext.Provider value={surfaceId}>
      {children}
    </SurfaceIdContext.Provider>
  );
}

/** The surface id of the pane this component is inside, if any. */
export function useSurfaceId(): string | null {
  return useContext(SurfaceIdContext);
}
