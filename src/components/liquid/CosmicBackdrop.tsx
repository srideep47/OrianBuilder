/**
 * The app backdrop: a violet nebula, a tiled starfield, film grain and a
 * vignette, all pure CSS (see the `.cosmos` block in `styles/design.css`).
 *
 * Mirrors OrionAndroid's `core/design/CosmicBackground.kt`. Deliberately not a
 * canvas: the previous `GalaxyBackground` ran a requestAnimationFrame loop over
 * up to 2,800 particles, and the architecture audit called out renderer cost as
 * a real problem. Two CSS keyframe animations on composited layers cost nothing
 * per frame and stop entirely under `prefers-reduced-motion`.
 *
 * Sits at `z-0` behind the shell; every surface above it uses the Liquid
 * material, so the nebula is what the glass is actually refracting.
 */
export function CosmicBackdrop() {
  return (
    <div className="cosmos" aria-hidden="true">
      <div className="orion-stage" />
      <div className="orion-stars" />
      <div className="orion-grain" />
      <div className="orion-vignette" />
    </div>
  );
}
