// Small dependency-free helpers shared by the simulation (worker + main thread).

export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (n) => Math.floor(rng() * n);
  rng.chance = (p) => rng() < p;
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.gauss = () => {
    const u = Math.max(rng(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  return rng;
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// Quaternions are [x, y, z, w]; vectors are [x, y, z].
export function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];

export function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function qeuler(rx, ry, rz) {
  const qx = [Math.sin(rx / 2), 0, 0, Math.cos(rx / 2)];
  const qy = [0, Math.sin(ry / 2), 0, Math.cos(ry / 2)];
  const qz = [0, 0, Math.sin(rz / 2), Math.cos(rz / 2)];
  return qmul(qmul(qx, qy), qz);
}

const S = Math.SQRT1_2;
// Rotation taking +Y onto the outward normal of box face f (f = axis*2 + (positive ? 1 : 0)).
export const FACE_ROT = [
  [0, 0, S, S], // -X
  [0, 0, -S, S], // +X
  [1, 0, 0, 0], // -Y
  [0, 0, 0, 1], // +Y
  [-S, 0, 0, S], // -Z
  [S, 0, 0, S], // +Z
];
