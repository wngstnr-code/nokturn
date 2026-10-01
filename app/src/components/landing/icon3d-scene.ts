import {contours} from "d3-contour";
import * as THREE from "three";

const MAX_TILT = 0.45;

type Layer = {shapes: THREE.Shape[]; color: THREE.Color; hex: string; lift: number};
type Traced = {layers: Layer[]; width: number; height: number; depth: number};

export type Icon3DOptions = {
  src: string;
  /** Paint the whole solid in this colour. Null keeps the SVG's own colours as layers. */
  color: string | null;
  still: boolean;
  /** The element whose visibility decides whether frames are drawn. */
  watch: Element;
  /** For a canvas that is not in the page. Without it the canvas's own box is used. */
  size?: {width: number; height: number};
  onFrame?: () => void;
  /** Fly instead of turning. The layers in these colours are the wings and flap. */
  wings?: string[];
};

function pointInRing(point: THREE.Vector2, ring: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

async function trace(src: string, color: string | null): Promise<Traced> {
  const text = await (await fetch(src)).text();
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(text);
  const width = Number(box?.[1] ?? 100);
  const height = Number(box?.[2] ?? 100);
  const longest = Math.max(width, height);

  // Pixels per icon unit. Fine enough that the bevel hides the steps, coarse enough
  // that a large illustration still traces well under a frame.
  const scale = THREE.MathUtils.clamp(600 / longest, 1.5, 4);
  const depth = longest * 0.15;

  const svg = color === null ? text : text.replace('fill="currentColor"', 'fill="#fff"');
  const url = URL.createObjectURL(new Blob([svg], {type: "image/svg+xml"}));
  const image = new Image();
  image.src = url;
  await image.decode();

  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d", {willReadFrequently: true});
  if (!context) throw new Error("no 2d context");
  context.drawImage(image, 0, 0, w, h);
  URL.revokeObjectURL(url);
  const pixels = context.getImageData(0, 0, w, h).data;

  const toVector = ([x, y]: number[]) => new THREE.Vector2(((x ?? 0) - w / 2) / scale, (h / 2 - (y ?? 0)) / scale);
  // The traced rings step one pixel at a time. Dropping points closer than half a
  // unit keeps the outline and spares the triangulator.
  const thin = (ring: number[][]) => {
    const kept: THREE.Vector2[] = [];
    for (const point of ring) {
      const v = toVector(point);
      const last = kept[kept.length - 1];
      if (!last || last.distanceTo(v) > 0.5) kept.push(v);
    }
    return kept;
  };
  const shapesOf = (grid: number[]) => {
    const [area] = contours().size([w, h]).thresholds([0.5])(grid);
    return (area?.coordinates ?? [])
      .map(([outer, ...holes]) => {
        const shape = new THREE.Shape(thin(outer ?? []));
        shape.holes = holes.map((hole) => new THREE.Path(thin(hole)));
        return shape;
      })
      // Antialiased seams between two colours leave slivers of a third. Anything this
      // small is one of those, not part of the drawing.
      .filter((shape) => Math.abs(THREE.ShapeUtils.area(shape.getPoints())) > longest * 0.02);
  };

  if (color !== null) {
    const shapes = shapesOf(Array.from({length: w * h}, (_, i) => ((pixels[i * 4 + 3] ?? 0) > 127 ? 1 : 0)));
    // A piece that sits inside another piece's hole, the beak in its gap or a pupil in
    // its eye, reads as part of the face only when it stands a little proud of it.
    const inside = (shape: THREE.Shape, other: THREE.Shape) => {
      const probe = shape.getPoints()[0];
      return probe !== undefined && other.holes.some((hole) => pointInRing(probe, hole.getPoints()));
    };
    const islands = shapes.filter((shape) => shapes.some((other) => other !== shape && inside(shape, other)));
    const body = shapes.filter((shape) => !islands.includes(shape));
    const tint = new THREE.Color(color);
    return {
      layers: [
        {shapes: body, color: tint, hex: color, lift: 0},
        {shapes: islands, color: tint, hex: color, lift: depth * 0.3},
      ],
      width,
      height,
      depth,
    };
  }

  // In document order, which is near enough to paint order that a later colour
  // standing taller reads as lying on top.
  const palette = [...new Set([...text.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1] ?? ""))];
  const rgb = palette.map((hex) => new THREE.Color(hex));
  const owner = new Int16Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if ((pixels[i * 4 + 3] ?? 0) < 128) continue;
    const r = (pixels[i * 4] ?? 0) / 255;
    const g = (pixels[i * 4 + 1] ?? 0) / 255;
    const b = (pixels[i * 4 + 2] ?? 0) / 255;
    let best = 0;
    let bestDistance = Infinity;
    rgb.forEach((c, index) => {
      const distance = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    owner[i] = best;
  }
  const layers = rgb.map((tint, index) => ({
    shapes: shapesOf(Array.from(owner, (o) => (o === index ? 1 : 0))),
    color: tint,
    hex: (palette[index] ?? "").toLowerCase(),
    lift: index * depth * 0.12,
  }));
  return {layers: layers.filter((layer) => layer.shapes.length > 0), width, height, depth};
}

/** Draws the icon at src as a lit, extruded solid on canvas. Returns a cleanup. */
export async function mountIcon3D(canvas: HTMLCanvasElement, options: Icon3DOptions): Promise<() => void> {
  const {src, color, still, watch, size, onFrame, wings} = options;
  const {layers, width, height, depth} = await trace(src, color);

  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();

  // The bevel is pulled inside the outline. Grown outward it closed the narrow gap
  // around the beak, and the face lost its mouth.
  const bevel = Math.max(width, height) * 0.009;
  const solid = new THREE.Group();
  const disposables: {dispose: () => void}[] = [];
  const solidOf = (shapes: THREE.Shape[], layer: Layer, thickness: number) => {
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: thickness,
      bevelEnabled: true,
      bevelThickness: bevel * 2,
      bevelSize: bevel,
      bevelOffset: -bevel,
      bevelSegments: 4,
      curveSegments: 4,
    });
    const material = new THREE.MeshStandardMaterial({color: layer.color, roughness: 0.34, metalness: 0.08});
    disposables.push(geometry, material);
    return new THREE.Mesh(geometry, material);
  };

  // Each wing turns on a hinge at its inner edge, where it meets the head. Left and
  // right are told apart by which side of the middle the piece sits on.
  const flight = wings?.map((hex) => hex.toLowerCase());
  const hinges: {left: THREE.Group[]; right: THREE.Group[]} = {left: [], right: []};
  for (const layer of layers) {
    if (layer.shapes.length === 0) continue;
    if (!flight?.includes(layer.hex)) {
      solid.add(solidOf(layer.shapes, layer, depth + layer.lift));
      continue;
    }
    for (const side of ["left", "right"] as const) {
      const pieces = layer.shapes.filter((shape) => {
        const box = new THREE.Box2().setFromPoints(shape.getPoints());
        const middleX = (box.min.x + box.max.x) / 2;
        return side === "left" ? middleX < 0 : middleX >= 0;
      });
      if (pieces.length === 0) continue;
      const box = new THREE.Box2().setFromPoints(pieces.flatMap((shape) => shape.getPoints()));
      const hinge = new THREE.Group();
      hinge.position.set(side === "left" ? box.max.x : box.min.x, (box.min.y + box.max.y) / 2, 0);
      // Thinner than the head, so a wing reads as a wing and not a slab.
      const wing = solidOf(pieces, layer, depth * 0.45 + layer.lift * 0.3);
      wing.position.set(-hinge.position.x, -hinge.position.y, depth * 0.2);
      hinge.add(wing);
      solid.add(hinge);
      hinges[side].push(hinge);
    }
  }
  const bounds = new THREE.Box3().setFromObject(solid);
  const middle = bounds.getCenter(new THREE.Vector3());
  solid.children.forEach((child) => child.position.sub(middle));
  const pivot = new THREE.Group();
  pivot.add(solid);
  scene.add(pivot);

  // A light colour on a dark card needs less fill or it washes out, and the reverse.
  const bright = color === null || new THREE.Color(color).getHSL({h: 0, s: 0, l: 0}).l > 0.5;
  // The illustrations keep their own colours, and they need the most light to read
  // as the colours they were drawn in rather than a shade darker.
  const fill = color === null ? 2 : bright ? 1.2 : 2.2;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8892c4, fill));
  const key = new THREE.DirectionalLight(0xffffff, color === null ? 2.2 : bright ? 1.8 : 4.2);
  key.position.set(-1.2, 1.6, 2.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb825, bright ? 0.9 : 3);
  rim.position.set(2.4, -0.4, 0.6);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(28, 1, 1, 8000);
  const fit = (w: number, h: number) => {
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Fit the icon's own height into the middle of the taller canvas, the way the flat
    // picture fitted its box.
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const byHeight = (height + depth) / 0.8 / 2 / half;
    const byWidth = (width + depth) / camera.aspect / 2 / half;
    camera.position.set(0, 0, Math.max(byHeight, byWidth));
    camera.updateProjectionMatrix();
  };
  let observer: ResizeObserver | undefined;
  if (size) {
    fit(size.width, size.height);
  } else {
    fit(canvas.clientWidth, canvas.clientHeight);
    observer = new ResizeObserver(() => fit(canvas.clientWidth, canvas.clientHeight));
    observer.observe(canvas);
  }

  const pointer = {x: 0, y: 0, active: false};
  const onMove = (event: PointerEvent) => {
    const rect = watch.getBoundingClientRect();
    pointer.x = THREE.MathUtils.clamp((event.clientX - (rect.left + rect.width / 2)) / (window.innerWidth / 2), -1, 1);
    pointer.y = THREE.MathUtils.clamp((event.clientY - (rect.top + rect.height / 2)) / (window.innerHeight / 2), -1, 1);
    pointer.active = true;
  };
  if (!still && !flight) window.addEventListener("pointermove", onMove, {passive: true});

  // Heading left, the way the marquee carries it, nose a little down.
  const fly = (t: number) => {
    const beat = Math.sin(t * 6.4);
    const stroke = beat * 0.62 + 0.08;
    hinges.left.forEach((hinge) => hinge.rotation.set(0, stroke * 0.45, -stroke));
    hinges.right.forEach((hinge) => hinge.rotation.set(0, -stroke * 0.45, stroke));
    pivot.rotation.set(0.22, -0.6 + Math.sin(t * 0.9) * 0.08, 0.1 + Math.sin(t * 1.3) * 0.04);
    // The body rises on the downstroke, a beat behind the wings.
    pivot.position.y = -Math.sin(t * 6.4 - 0.9) * height * 0.05;
  };

  let visible = false;
  const seen = new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? false));
  seen.observe(watch);

  const draw = () => {
    renderer.render(scene, camera);
    onFrame?.();
  };
  const clock = new THREE.Clock();
  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);
    if (!visible) return;
    const t = clock.getElapsedTime();
    if (flight) {
      fly(t);
      draw();
      return;
    }
    const targetY = pointer.active ? pointer.x * MAX_TILT : Math.sin(t * 0.6) * 0.42;
    const targetX = pointer.active ? pointer.y * MAX_TILT * 0.6 : Math.sin(t * 0.45) * 0.08;
    pivot.rotation.y += (targetY - pivot.rotation.y) * 0.06;
    pivot.rotation.x += (targetX - pivot.rotation.x) * 0.06;
    pivot.position.y = Math.sin(t * 1.1) * height * 0.01;
    draw();
  };
  if (still) {
    if (flight) fly(0.25);
    else pivot.rotation.set(0.12, -0.32, 0);
    draw();
  } else {
    tick();
  }

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onMove);
    observer?.disconnect();
    seen.disconnect();
    disposables.forEach((item) => item.dispose());
    renderer.dispose();
  };
}
