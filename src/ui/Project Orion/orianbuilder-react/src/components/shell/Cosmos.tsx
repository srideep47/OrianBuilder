import { useEffect, useRef } from 'react';

interface Star {
  x: number; y: number; r: number; s: number; a: number; p: number; pf: number;
}

export function Cosmos() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shoot1Ref = useRef<HTMLDivElement>(null);
  const shoot2Ref = useRef<HTMLDivElement>(null);

  /* ─── Animated star field ─── */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    let w = 0, h = 0, t = 0, raf = 0;
    let stars: Star[] = [];

    const dpr = () => window.devicePixelRatio || 1;

    function build() {
      stars = [];
      const layers = [
        { n: 120, s: 0.3, r: 0.4, a: 0.4 },
        { n: 80,  s: 0.6, r: 0.8, a: 0.7 },
        { n: 40,  s: 1.0, r: 1.4, a: 1.0 },
      ];
      layers.forEach((L) => {
        for (let i = 0; i < L.n; i++) {
          stars.push({
            x: Math.random() * w,
            y: Math.random() * h,
            r: L.r * (0.5 + Math.random() * 0.8),
            s: L.s * (0.05 + Math.random() * 0.08),
            a: L.a,
            p: Math.random() * Math.PI * 2,
            pf: 0.4 + Math.random() * 1.6,
          });
        }
      });
    }

    function resize() {
      const d = dpr();
      w = c!.width = window.innerWidth * d;
      h = c!.height = window.innerHeight * d;
      c!.style.width = `${window.innerWidth}px`;
      c!.style.height = `${window.innerHeight}px`;
      build();
    }

    function loop() {
      t += 0.012;
      const d = dpr();
      ctx!.clearRect(0, 0, w, h);
      stars.forEach((st) => {
        st.x -= st.s * d;
        if (st.x < -4) st.x = w + 4;
        const tw = 0.5 + Math.sin(t * st.pf + st.p) * 0.5;
        ctx!.globalAlpha = st.a * (0.4 + tw * 0.6);
        ctx!.fillStyle = '#fff';
        ctx!.beginPath();
        ctx!.arc(st.x, st.y, st.r * d, 0, Math.PI * 2);
        ctx!.fill();
        if (st.r > 1.1) {
          ctx!.globalAlpha = st.a * tw * 0.3;
          ctx!.beginPath();
          ctx!.arc(st.x, st.y, st.r * 3 * d, 0, Math.PI * 2);
          ctx!.fill();
        }
      });
      raf = requestAnimationFrame(loop);
    }

    window.addEventListener('resize', resize);
    resize();
    loop();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
    };
  }, []);

  /* ─── Shooting stars ─── */
  useEffect(() => {
    function fireShooter(el: HTMLDivElement | null) {
      if (!el) return;
      const top = Math.random() * 60 + 'vh';
      const left = Math.random() * 40 + 'vw';
      const ang = 20 + Math.random() * 15;
      el.style.cssText =
        `position:absolute;top:${top};left:${left};transform:rotate(${ang}deg);width:140px;height:1px;` +
        `background:linear-gradient(90deg,transparent,#fff,transparent);opacity:0;` +
        `filter:drop-shadow(0 0 4px #c5b3ff);transform-origin:left center`;
      el.animate(
        [
          { opacity: 0, transform: `rotate(${ang}deg) translateX(0)` },
          { opacity: 1, offset: 0.2 },
          { opacity: 1, offset: 0.8 },
          { opacity: 0, transform: `rotate(${ang}deg) translateX(700px)` },
        ],
        { duration: 1100, easing: 'cubic-bezier(.2,.6,.4,1)' },
      );
    }

    const t1 = (() => {
      let id: number;
      function loop() {
        fireShooter(shoot1Ref.current);
        id = window.setTimeout(loop, 3000 + Math.random() * 7000);
      }
      id = window.setTimeout(loop, 2000);
      return () => clearTimeout(id);
    })();

    const t2 = (() => {
      let id: number;
      function loop() {
        fireShooter(shoot2Ref.current);
        id = window.setTimeout(loop, 3000 + Math.random() * 7000);
      }
      id = window.setTimeout(loop, 4500);
      return () => clearTimeout(id);
    })();

    return () => { t1(); t2(); };
  }, []);

  return (
    <div className="cosmos">
      <canvas ref={canvasRef} className="starfield" />
      <div className="nebula" />
      <div className="grid-overlay" />
      <div ref={shoot1Ref} className="shooter" />
      <div ref={shoot2Ref} className="shooter" />
    </div>
  );
}
