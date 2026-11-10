// Worlds a creature can be evaluated in.

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const flat = () => 0;

// Rolling terrain that is level near the spawn point.
const hills = (x, z) =>
  0.9 *
  smooth(2, 7, Math.hypot(x, z)) *
  (0.6 * Math.sin(x * 0.5) * Math.cos(z * 0.4) + Math.sin(x * 0.23 + 1.3) * Math.sin(z * 0.31 + 0.7));

// Target positions for goals that use a target; each one is a separate trial.
const ring = (dist, ys) => ys.map((y, i) => {
  const a = (Math.PI / 6) + (i * 2 * Math.PI) / ys.length;
  return [Math.cos(a) * dist, y, Math.sin(a) * dist];
});

export const ENVS = {
  land: {
    name: 'Flat land',
    blurb: 'Earth gravity on level ground with good grip.',
    gravity: 9.81, friction: 1.0, terrain: 'flat', heightAt: flat, water: false,
    targets: ring(9, [0.5, 0.5, 0.5]),
  },
  hills: {
    name: 'Hills',
    blurb: 'Earth gravity on rolling, uneven terrain.',
    gravity: 9.81, friction: 1.0, terrain: 'hills', heightAt: hills, water: false,
    targets: ring(9, [0.5, 0.5, 0.5]),
  },
  water: {
    name: 'Water',
    blurb: 'No gravity and no ground; moving a surface through the water pushes back.',
    gravity: 0, friction: 0, terrain: null, heightAt: flat, water: true, drag: 2.0,
    targets: ring(8, [3, -3, 0]),
  },
  moon: {
    name: 'Moon',
    blurb: 'One-sixth gravity on level ground.',
    gravity: 1.62, friction: 1.0, terrain: 'flat', heightAt: flat, water: false,
    targets: ring(9, [0.5, 0.5, 0.5]),
  },
  ice: {
    name: 'Ice',
    blurb: 'Earth gravity on level ground with almost no grip.',
    gravity: 9.81, friction: 0.04, terrain: 'flat', heightAt: flat, water: false,
    targets: ring(9, [0.5, 0.5, 0.5]),
  },
};

// Triangle mesh for uneven terrain, shared by the physics and the renderer.
export const TERRAIN_EXTENT = 70;
export const TERRAIN_CELLS = 96;
export function terrainMesh(heightAt) {
  const n = TERRAIN_CELLS;
  const step = (2 * TERRAIN_EXTENT) / n;
  const vertices = new Float32Array((n + 1) * (n + 1) * 3);
  const indices = new Uint32Array(n * n * 6);
  let v = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = -TERRAIN_EXTENT + j * step;
      const z = -TERRAIN_EXTENT + i * step;
      vertices[v++] = x;
      vertices[v++] = heightAt(x, z);
      vertices[v++] = z;
    }
  }
  let t = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }
  return { vertices, indices };
}
