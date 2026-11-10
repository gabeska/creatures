// Genotype: a directed graph of nodes, after Karl Sims (1994).
// Each node describes a rigid box, the joint attaching it to its parent, and a
// small local neural circuit. Connections say where child parts grow; a node
// may connect to itself (recursion) or be reused several times (repetition),
// and a connection may be reflected to give bilateral symmetry.

import { clamp } from './util.js';

export const N_SENSORS = 10; // angle, contact, tilt, target xyz, constant, rival xyz
export const SENSOR_NAMES = ['joint angle', 'contact', 'tilt', 'target x', 'target y', 'target z', 'constant', 'rival x', 'rival y', 'rival z'];
export const FNS = ['sum', 'prod', 'thresh', 'gt', 'abs', 'min', 'max', 'if', 'sin', 'tanh', 'smooth', 'diff', 'wave', 'saw'];
export const MAX_NODES = 8;
const MAX_NEURONS = 6;
const MAX_CONNS = 4;
const SIZE_MIN = 0.07;
const SIZE_MAX = 0.45;

function randomInput(rng, preferNeuron = false) {
  const r = rng();
  return {
    scope: r < 0.6 ? 0 : r < 0.75 ? 1 : r < 0.9 ? 2 : 3, // local, parent, child, root
    k: rng.int(4),
    idx: preferNeuron ? N_SENSORS + rng.int(MAX_NEURONS) : rng.int(N_SENSORS + MAX_NEURONS),
    w: rng.range(-2, 2),
  };
}

function randomNeuron(rng) {
  const r = rng();
  const fn = r < 0.3 ? 'wave' : r < 0.4 ? 'saw' : rng.pick(FNS);
  return {
    fn,
    inputs: [randomInput(rng), randomInput(rng), randomInput(rng)],
    p: rng(), // oscillator frequency
    q: rng(), // oscillator phase
  };
}

function randomConn(rng, nNodes) {
  return {
    to: rng.int(nNodes),
    face: rng.int(6),
    u: rng.range(-0.9, 0.9),
    v: rng.range(-0.9, 0.9),
    scale: rng.range(0.7, 1.1),
    reflect: rng.chance(0.4),
    terminal: rng.chance(0.15),
    rot: [rng.range(-0.8, 0.8), rng.range(-0.8, 0.8), rng.range(-0.8, 0.8)],
  };
}

function randomNode(rng) {
  const neurons = [];
  const n = rng.int(4);
  for (let i = 0; i < n; i++) neurons.push(randomNeuron(rng));
  return {
    size: [rng.range(SIZE_MIN, SIZE_MAX), rng.range(SIZE_MIN, SIZE_MAX), rng.range(SIZE_MIN, SIZE_MAX)],
    axis: rng.int(3),
    rigid: rng.chance(0.08),
    lo: -rng.range(0.3, 1.4),
    hi: rng.range(0.3, 1.4),
    recur: rng.chance(0.25) ? 2 + rng.int(2) : 1,
    neurons,
    effector: randomInput(rng, true),
    conns: [],
  };
}

export function randomGenome(rng) {
  const n = 1 + rng.int(4);
  const nodes = [];
  for (let i = 0; i < n; i++) nodes.push(randomNode(rng));
  for (let i = 0; i < n; i++) {
    const c = (i === 0 ? 1 : 0) + rng.int(3);
    for (let j = 0; j < c; j++) nodes[i].conns.push(randomConn(rng, n));
  }
  return { nodes };
}

export const cloneGenome = (g) => JSON.parse(JSON.stringify({ nodes: g.nodes }));

// Drop nodes that cannot be reached from the root and renumber the rest.
function collect(g) {
  const n = g.nodes.length;
  for (const node of g.nodes) for (const c of node.conns) c.to = ((c.to % n) + n) % n;
  const map = new Map([[0, 0]]);
  const order = [0];
  for (let i = 0; i < order.length; i++) {
    for (const c of g.nodes[order[i]].conns) {
      if (!map.has(c.to) && order.length < MAX_NODES) {
        map.set(c.to, order.length);
        order.push(c.to);
      }
    }
  }
  const nodes = order.map((i) => g.nodes[i]);
  for (const node of nodes) {
    node.conns = node.conns.filter((c) => map.has(c.to));
    for (const c of node.conns) c.to = map.get(c.to);
  }
  g.nodes = nodes;
  return g;
}

function mutateInput(inp, rng, rate) {
  if (rng.chance(rate)) inp.scope = randomInput(rng).scope;
  if (rng.chance(rate)) inp.k = rng.int(4);
  if (rng.chance(rate)) inp.idx = rng.int(N_SENSORS + MAX_NEURONS);
  if (rng.chance(rate)) inp.w = clamp(inp.w + rng.gauss() * 0.5, -3, 3);
}

const nudge = (x, rng, sd, lo, hi) => clamp(x + rng.gauss() * sd, lo, hi);

export function mutate(parent, rng, rate = 0.12) {
  const g = cloneGenome(parent);
  // Scale the per-gene rate so that bigger genomes do not mutate more overall.
  const r = clamp((rate * 3) / (g.nodes.length + 2), 0.01, 0.5);

  for (const node of g.nodes) {
    for (let i = 0; i < 3; i++) if (rng.chance(r)) node.size[i] = nudge(node.size[i], rng, 0.08, SIZE_MIN, SIZE_MAX);
    if (rng.chance(r)) node.axis = rng.int(3);
    if (rng.chance(r * 0.5)) node.rigid = !node.rigid;
    if (rng.chance(r)) node.lo = nudge(node.lo, rng, 0.25, -1.5, -0.1);
    if (rng.chance(r)) node.hi = nudge(node.hi, rng, 0.25, 0.1, 1.5);
    if (rng.chance(r * 0.5)) node.recur = clamp(node.recur + (rng.chance(0.5) ? 1 : -1), 1, 4);
    mutateInput(node.effector, rng, r);

    for (const nr of node.neurons) {
      if (rng.chance(r * 0.5)) nr.fn = randomNeuron(rng).fn;
      if (rng.chance(r)) nr.p = nudge(nr.p, rng, 0.15, 0, 1);
      if (rng.chance(r)) nr.q = nudge(nr.q, rng, 0.15, 0, 1);
      for (const inp of nr.inputs) mutateInput(inp, rng, r);
    }
    if (rng.chance(r) && node.neurons.length < MAX_NEURONS) node.neurons.push(randomNeuron(rng));
    if (rng.chance(r * 0.5) && node.neurons.length > 0) node.neurons.splice(rng.int(node.neurons.length), 1);

    for (const c of node.conns) {
      if (rng.chance(r * 0.5)) c.to = rng.int(g.nodes.length);
      if (rng.chance(r * 0.5)) c.face = rng.int(6);
      if (rng.chance(r)) c.u = nudge(c.u, rng, 0.3, -1, 1);
      if (rng.chance(r)) c.v = nudge(c.v, rng, 0.3, -1, 1);
      if (rng.chance(r)) c.scale = nudge(c.scale, rng, 0.1, 0.5, 1.3);
      if (rng.chance(r * 0.5)) c.reflect = !c.reflect;
      if (rng.chance(r * 0.5)) c.terminal = !c.terminal;
      for (let i = 0; i < 3; i++) if (rng.chance(r)) c.rot[i] = nudge(c.rot[i], rng, 0.3, -1.5, 1.5);
    }
    if (rng.chance(r) && node.conns.length < MAX_CONNS) node.conns.push(randomConn(rng, g.nodes.length));
    if (rng.chance(r * 0.7) && node.conns.length > 0) node.conns.splice(rng.int(node.conns.length), 1);
  }

  // Occasionally grow a brand-new node somewhere on the graph.
  if (rng.chance(rate) && g.nodes.length < MAX_NODES) {
    const node = randomNode(rng);
    g.nodes.push(node);
    const host = rng.pick(g.nodes);
    if (host.conns.length < MAX_CONNS) {
      const c = randomConn(rng, g.nodes.length);
      c.to = g.nodes.length - 1;
      host.conns.push(c);
    }
  }
  return collect(g);
}

// Sims' crossover: align the node lists and switch parents at a crossover point.
export function crossover(a, b, rng) {
  const cut = 1 + rng.int(Math.max(1, Math.min(a.nodes.length, b.nodes.length)));
  const nodes = [...cloneGenome(a).nodes.slice(0, cut), ...cloneGenome(b).nodes.slice(cut)];
  return collect({ nodes });
}

// Sims' grafting: a connection in one parent is redirected to a node of the other.
export function graft(a, b, rng) {
  const g = cloneGenome(a);
  const donor = cloneGenome(b).nodes;
  const offset = g.nodes.length;
  for (const node of donor) for (const c of node.conns) c.to += offset;
  const host = rng.pick(g.nodes);
  const target = offset + rng.int(donor.length);
  g.nodes.push(...donor);
  if (host.conns.length > 0 && rng.chance(0.6)) rng.pick(host.conns).to = target;
  else {
    const c = randomConn(rng, g.nodes.length);
    c.to = target;
    host.conns.push(c);
  }
  return collect(g);
}
