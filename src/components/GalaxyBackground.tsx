import { useEffect, useRef } from "react";

// ─── Palette sampled from the reference cosmic image ───────────────────────
// RGB triplets weighted by their real frequency:
// warm orange/ember dominate bottom-left → violet/steel top-right
const PALETTE = [
  { r: 200, g: 95, b: 55, w: 14, group: 0 },
  { r: 220, g: 130, b: 70, w: 12, group: 0 },
  { r: 245, g: 175, b: 100, w: 9, group: 0 },
  { r: 160, g: 70, b: 50, w: 11, group: 0 },
  { r: 120, g: 55, b: 50, w: 8, group: 0 },
  { r: 255, g: 215, b: 145, w: 4, group: 0 },
  { r: 130, g: 72, b: 82, w: 4, group: 1 },
  { r: 150, g: 85, b: 100, w: 3, group: 1 },
  { r: 180, g: 110, b: 130, w: 2, group: 1 },
  { r: 110, g: 70, b: 130, w: 4, group: 2 },
  { r: 135, g: 85, b: 150, w: 3, group: 2 },
  { r: 80, g: 60, b: 120, w: 4, group: 2 },
  { r: 165, g: 100, b: 175, w: 2, group: 2 },
  { r: 60, g: 75, b: 125, w: 4, group: 3 },
  { r: 80, g: 100, b: 145, w: 3, group: 3 },
  { r: 55, g: 85, b: 115, w: 2, group: 3 },
  { r: 45, g: 110, b: 75, w: 1, group: 4 },
  { r: 60, g: 140, b: 90, w: 1, group: 4 },
] as const;

type PaletteEntry = {
  r: number;
  g: number;
  b: number;
  w: number;
  group: number;
};

const PALETTE_BY_GROUP: PaletteEntry[][] = [[], [], [], [], []];
PALETTE.forEach((c) => {
  for (let i = 0; i < c.w; i++)
    PALETTE_BY_GROUP[c.group].push(c as PaletteEntry);
});

function pickColor(x: number, y: number, w: number, h: number): PaletteEntry {
  const xN = x / w;
  const yN = y / h;
  const warmth = Math.max(0, Math.min(1, (1 - xN) * 0.55 + yN * 0.45));
  const r = Math.random();
  const pick = (g: number) =>
    PALETTE_BY_GROUP[g][Math.floor(Math.random() * PALETTE_BY_GROUP[g].length)];

  if (warmth > 0.65) {
    if (r < 0.86) return pick(0);
    if (r < 0.94) return pick(1);
    if (r < 0.98) return pick(2);
    return pick(4);
  }
  if (warmth > 0.42) {
    if (r < 0.55) return pick(0);
    if (r < 0.75) return pick(1);
    if (r < 0.93) return pick(2);
    return pick(3);
  }
  if (r < 0.4) return pick(2);
  if (r < 0.78) return pick(3);
  if (r < 0.92) return pick(0);
  if (r < 0.98) return pick(1);
  return pick(4);
}

function brighten(c: PaletteEntry, k = 0.45) {
  return {
    r: Math.min(255, c.r + (255 - c.r) * k),
    g: Math.min(255, c.g + (255 - c.g) * k),
    b: Math.min(255, c.b + (255 - c.b) * k),
  };
}

// FLW (Flow) parameters — locked
const FLOW = { speed: 1.0, length: 1.3, width: 0.9 };
// Diagonal angle: ~240° base (down-right) + 13° fixed bend
const BASE_ANGLE = ((240 + 13) * Math.PI) / 180;

interface Ray {
  x: number;
  y: number;
  len: number;
  thick: number;
  color: PaletteEntry;
  sp: number;
  ao: number;
  tw: number;
  twSp: number;
  br: number;
  hot: boolean;
}

function makeRay(W: number, H: number): Ray {
  const x = Math.random() * W * 1.4 - W * 0.2;
  const y = Math.random() * H * 1.4 - H * 0.2;
  const rnd = Math.random();
  const lenBase =
    rnd < 0.7 ? 30 + Math.random() * 90 : 140 + Math.random() * 280;
  return {
    x,
    y,
    len: lenBase * FLOW.length,
    thick:
      (Math.random() < 0.85
        ? 0.6 + Math.random() * 0.9
        : 1.6 + Math.random() * 1.6) * FLOW.width,
    color: pickColor(x, y, W, H),
    sp: 0.4 + Math.random() * 1.4,
    ao: (Math.random() - 0.5) * 0.05,
    tw: Math.random() * Math.PI * 2,
    twSp: 0.5 + Math.random() * 1.5,
    br: 0.45 + Math.random() * 0.55,
    hot: Math.random() < 0.18,
  };
}

function targetCount(W: number, H: number) {
  return Math.max(700, Math.min(2800, Math.round((W * H) / 900)));
}

const dirX = Math.cos(BASE_ANGLE);
const dirY = Math.sin(BASE_ANGLE);

export function GalaxyBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = 0;
    let H = 0;
    let DPR = 1;
    let rays: Ray[] = [];
    let raf = 0;
    let last = performance.now();
    // Pause the animation loop when the window/tab is hidden
    let paused = document.hidden;

    const onVisibilityChange = () => {
      paused = document.hidden;
      if (!paused && raf === 0) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const resize = () => {
      // Cap DPR at 1 — retina-scale canvas doubles GPU memory for a background
      DPR = Math.min(window.devicePixelRatio || 1, 1);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.floor(W * DPR);
      canvas.height = Math.floor(H * DPR);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      // Use 50% of the original ray count — still visually rich, half the GPU work
      rays = Array.from(
        { length: Math.round(targetCount(W, H) * 0.5) },
        () => makeRay(W, H),
      );
    };

    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const speedScale = reduce ? 0.12 : 1;

    // Frame-rate throttle: target 30 fps instead of 60 (background eye-candy)
    const TARGET_FRAME_MS = 1000 / 30;
    let lastFrameTime = 0;

    const loop = (now: number) => {
      if (paused) {
        raf = 0;
        return;
      }
      // Skip frame if we haven't waited long enough (30 fps cap)
      if (now - lastFrameTime < TARGET_FRAME_MS) {
        raf = requestAnimationFrame(loop);
        return;
      }
      lastFrameTime = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // Low-alpha clear → motion-blur trails
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(4, 3, 10, 0.22)";
      ctx.fillRect(0, 0, W, H);

      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      for (const ray of rays) {
        const ang = BASE_ANGLE + ray.ao;
        const speed = 60 * ray.sp * FLOW.speed * speedScale;
        ray.x += Math.cos(ang) * speed * dt;
        ray.y += Math.sin(ang) * speed * dt;

        const margin = 220;
        if (
          ray.x > W + margin ||
          ray.y > H + margin ||
          ray.x < -margin ||
          ray.y < -margin
        ) {
          const t = Math.random();
          ray.x = -margin + (W + margin * 2) * t - dirX * 240;
          ray.y = -margin + (H + margin * 2) * t - dirY * 240;
          ray.color = pickColor(ray.x, ray.y, W, H);
        }

        ray.tw += dt * ray.twSp;
        const tw = 0.55 + 0.45 * Math.sin(ray.tw);

        const len = ray.len * (0.7 + 0.3 * ray.sp);
        const ex = ray.x + Math.cos(ang) * len;
        const ey = ray.y + Math.sin(ang) * len;

        const col = ray.color;
        const core = brighten(col, 0.45);
        const alpha = ray.br * tw * 0.9;

        const grad = ctx.createLinearGradient(ray.x, ray.y, ex, ey);
        grad.addColorStop(
          0.0,
          `rgba(${col.r | 0},${col.g | 0},${col.b | 0},0)`,
        );
        grad.addColorStop(
          0.3,
          `rgba(${col.r | 0},${col.g | 0},${col.b | 0},${alpha * 0.5})`,
        );
        grad.addColorStop(
          0.6,
          `rgba(${core.r | 0},${core.g | 0},${core.b | 0},${alpha})`,
        );
        grad.addColorStop(
          0.85,
          `rgba(${col.r | 0},${col.g | 0},${col.b | 0},${alpha * 0.6})`,
        );
        grad.addColorStop(
          1.0,
          `rgba(${col.r | 0},${col.g | 0},${col.b | 0},0)`,
        );

        ctx.strokeStyle = grad;
        ctx.lineWidth = ray.thick;
        ctx.beginPath();
        ctx.moveTo(ray.x, ray.y);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        // Hot-head sparkle on brightest rays
        if (ray.hot && tw > 0.82) {
          const hx = ray.x + Math.cos(ang) * len * 0.65;
          const hy = ray.y + Math.sin(ang) * len * 0.65;
          const hot = brighten(col, 0.7);
          const radius = 5 * ray.thick;
          const rg = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius);
          rg.addColorStop(
            0,
            `rgba(${hot.r | 0},${hot.g | 0},${hot.b | 0},${0.85 * tw})`,
          );
          rg.addColorStop(
            0.4,
            `rgba(${core.r | 0},${core.g | 0},${core.b | 0},${0.45 * tw})`,
          );
          rg.addColorStop(1, `rgba(${col.r | 0},${col.g | 0},${col.b | 0},0)`);
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(hx, hy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(loop);
    };

    window.addEventListener("resize", resize);
    resize();
    if (!paused) raf = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
  }, []);

  return (
    <div className="cosmos" aria-hidden="true">
      {/* Deep-space warm amber → navy wash */}
      <div className="orion-stage" />
      {/* Drifting starfield */}
      <div className="orion-stars" />
      {/* Canvas: cosmic rays (mix-blend-mode: screen) */}
      <canvas ref={canvasRef} className="orion-streaks starfield" />
      {/* Filmic grain */}
      <div className="orion-grain" />
      {/* Vignette */}
      <div className="orion-vignette" />
    </div>
  );
}
