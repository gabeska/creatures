// Development: grow a body (a tree of boxes) from the genotype graph.

import { clamp, qmul, qrot, qeuler, qnorm, FACE_ROT } from './util.js';

export const MAX_PARTS = 14;
const MAX_DEPTH = 6;

// Returns an array of parts. Positions and rotations are in the creature's own
// frame, with the root part at the origin.
export function develop(genome) {
  const nodes = genome.nodes;
  const parts = [];
  const queue = [{ node: 0, parent: -1, conn: null, scale: 1, counts: {}, mirror: false, depth: 0 }];

  while (queue.length && parts.length < MAX_PARTS) {
    const item = queue.shift();
    const node = nodes[item.node];
    const half = node.size.map((s) => Math.max(0.04, s * item.scale));
    const part = {
      node: item.node,
      parent: item.parent,
      half,
      pos: [0, 0, 0],
      rot: [0, 0, 0, 1],
      anchor: [0, 0, 0],
      axis: [1, 0, 0],
      lo: node.lo,
      hi: node.hi,
      rigid: node.rigid,
      children: [],
    };

    if (item.parent >= 0) {
      const P = parts[item.parent];
      const c = item.conn;
      const a = c.face >> 1;
      const sign = c.face & 1 ? 1 : -1;
      const b = (a + 1) % 3;
      const d = (a + 2) % 3;
      const anchor = [0, 0, 0];
      anchor[a] = sign * P.half[a];
      anchor[b] = c.u * P.half[b];
      anchor[d] = c.v * P.half[d];
      let q = qmul(FACE_ROT[c.face], qeuler(c.rot[0], c.rot[1], c.rot[2]));
      const axis = [0, 0, 0];
      axis[node.axis] = 1;
      if (item.mirror) {
        // Reflect through the parent's local YZ plane.
        anchor[0] = -anchor[0];
        q = [q[0], -q[1], -q[2], q[3]];
        axis[1] = -axis[1];
        axis[2] = -axis[2];
      }
      part.rot = qnorm(qmul(P.rot, q));
      const A = qrot(P.rot, anchor);
      part.anchor = [P.pos[0] + A[0], P.pos[1] + A[1], P.pos[2] + A[2]];
      const off = qrot(part.rot, [0, half[1], 0]);
      part.pos = [part.anchor[0] + off[0], part.anchor[1] + off[1], part.anchor[2] + off[2]];
      part.axis = qrot(part.rot, axis);
      P.children.push(parts.length);
    }

    const index = parts.length;
    parts.push(part);
    if (item.depth >= MAX_DEPTH) continue;

    const counts = { ...item.counts, [item.node]: (item.counts[item.node] || 0) + 1 };
    const atEnd = counts[item.node] >= node.recur;
    for (const c of node.conns) {
      if (c.terminal && !atEnd) continue;
      if ((counts[c.to] || 0) >= nodes[c.to].recur) continue;
      const scale = clamp(item.scale * c.scale, 0.35, 1.4);
      const base = { node: c.to, parent: index, conn: c, scale, counts, depth: item.depth + 1 };
      queue.push({ ...base, mirror: item.mirror });
      if (c.reflect) queue.push({ ...base, mirror: !item.mirror });
    }
  }
  return parts;
}

export const isViable = (genome) => {
  const parts = develop(genome);
  return parts.length >= 2 && parts.some((p) => p.parent >= 0 && !p.rigid);
};
