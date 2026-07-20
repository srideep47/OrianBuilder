import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, Center, OrbitControls, useGLTF } from "@react-three/drei";

function GlbModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <primitive object={scene} />;
}

export default function ModelViewer({ url }: { url: string }) {
  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-2xl border border-border bg-[oklch(0.13_0.02_280)]">
      <Canvas
        key={url}
        camera={{ position: [2, 1.5, 2.5], fov: 40 }}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#1a1226"]} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[5, 8, 5]} intensity={1.1} />
        <directionalLight position={[-5, 3, -3]} intensity={0.55} />
        <directionalLight position={[0, -4, 4]} intensity={0.35} />
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.25}>
            <Center>
              <GlbModel url={url} />
            </Center>
          </Bounds>
        </Suspense>
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          autoRotate
          autoRotateSpeed={1.2}
          makeDefault
        />
      </Canvas>
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/40 px-2 py-1 text-[10px] text-white/80">
        Drag to rotate · scroll to zoom
      </div>
    </div>
  );
}
