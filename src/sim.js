// Physical simulation of one creature. Used both headless (fitness evaluation
// in workers) and stepped frame by frame by the viewer, so what you watch is
// exactly what was scored.

import { clamp, qmul, qconj, qrot } from './util.js';
import { N_SENSORS } from './genome.js';
import { develop } from './phenotype.js';
import { terrainMesh } from './environments.js';
import { usesTarget, INVALID } from './goals.js';

export const DT = 1 / 60;
const SETTLE_STEPS = 90; // let the body come to rest before the brain switches on
const DENSITY = 1;
const MUSCLE = 22; // joint stiffness per unit of cross-section area
const SLEW = 7; // fastest a muscle can change its target angle, rad/s
const MAX_JOINT_HZ = 25; // highest natural frequency a joint spring may have, rad/s
const ARMATURE = 0.3;
const MASS_RATIO = 0.5;
const MAX_SPEED = 15; // anything faster is a physics glitch, not a gait
const GROUND = 0x00010002;
const BODY = 0x00020001; // parts touch the ground but not each other

const terrainCache = new Map();
const IDENT = { x: 0, y: 0, z: 0, w: 1 };
const V = (a) => ({ x: a[0], y: a[1], z: a[2] });
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export class Simulation {
  constructor(RAPIER, genome, env, { duration = 10, target = null } = {}) {
    this.R = RAPIER;
    this.env = env;
    this.target = target;
    this.settle = env.water ? 0 : SETTLE_STEPS;
    this.totalSteps = this.settle + Math.round(duration / DT);
    this.stepCount = 0;
    this.valid = true;
    this.time = 0;

    const world = (this.world = new RAPIER.World({ x: 0, y: -env.gravity, z: 0 }));
    world.timestep = DT;
    world.numSolverIterations = 8;

    this.ground = null;
    if (env.terrain) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      let desc;
      if (env.terrain === 'flat') {
        desc = RAPIER.ColliderDesc.cuboid(1000, 1, 1000).setTranslation(0, -1, 0);
      } else {
        if (!terrainCache.has(env.terrain)) terrainCache.set(env.terrain, terrainMesh(env.heightAt));
        const mesh = terrainCache.get(env.terrain);
        desc = RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices);
      }
      this.ground = world.createCollider(desc.setFriction(env.friction).setCollisionGroups(GROUND), body);
    }

    const parts = (this.parts = develop(genome));

    // Stand the creature on the ground.
    let lift = 0;
    if (env.terrain) {
      let lowest = Infinity;
      for (const p of parts) lowest = Math.min(lowest, p.pos[1] - extentY(p.rot, p.half));
      lift = 0.03 - lowest;
    }

    // A light part joined to a heavy one far from the joint makes the solver
    // diverge, so every part gets some extra rotational inertia ("armature")
    // in proportion to what its neighbours hang off it.
    for (const p of parts) {
      p.mass = 8 * p.half[0] * p.half[1] * p.half[2] * DENSITY;
      p.arm = 0;
    }
    for (const p of parts) {
      if (p.parent < 0) continue;
      const P = parts[p.parent];
      const d2 = (q) => { const r = sub(q.pos, p.anchor); return r[0] * r[0] + r[1] * r[1] + r[2] * r[2]; };
      p.arm = Math.max(p.arm, ARMATURE * (P.mass * d2(P) + p.mass * d2(p)));
      P.arm = Math.max(P.arm, ARMATURE * (p.mass * d2(p) + P.mass * d2(P)));
      p.heaviest = Math.max(p.heaviest || 0, P.mass);
      P.heaviest = Math.max(P.heaviest || 0, p.mass);
    }
    // Likewise a part is never much lighter than its heaviest neighbour.
    for (const p of parts) {
      p.extra = Math.max(0, MASS_RATIO * (p.heaviest || 0) - p.mass);
      p.mass += p.extra;
    }

    this.totalMass = 0;
    for (const p of parts) {
      p.body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p.pos[0], p.pos[1] + lift, p.pos[2])
          .setCanSleep(false)
          .setAngularDamping(0.05)
          .setAdditionalMassProperties(p.extra, { x: 0, y: 0, z: 0 }, { x: p.arm, y: p.arm, z: p.arm }, IDENT)
      );
      p.collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(p.half[0], p.half[1], p.half[2])
          .setRotation({ x: p.rot[0], y: p.rot[1], z: p.rot[2], w: p.rot[3] })
          .setDensity(DENSITY)
          .setFriction(env.friction)
          .setCollisionGroups(BODY),
        p.body
      );
      this.totalMass += p.mass;
      p.joint = null;
      p.out = 0;
      p.aim = 0;
    }

    for (const p of parts) {
      if (p.parent < 0) continue;
      const P = parts[p.parent];
      const a1 = V(sub(p.anchor, P.pos));
      const a2 = V(sub(p.anchor, p.pos));
      if (p.rigid) {
        world.createImpulseJoint(RAPIER.JointData.fixed(a1, IDENT, a2, IDENT), P.body, p.body, true);
        continue;
      }
      // All bodies start with the same orientation, so one axis serves both.
      const joint = world.createImpulseJoint(RAPIER.JointData.revolute(a1, a2, V(p.axis)), P.body, p.body, true);
      joint.setLimits(p.lo, p.hi);
      joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
      // Strength scales with cross-section area, as muscles do.
      const area = (h) => 4 * Math.min(h[0] * h[1], h[1] * h[2], h[0] * h[2]);
      // ...but capped for very light limbs, which the solver cannot hold stiffly.
      const ic = axisInertia(p, p.axis);
      const ip = axisInertia(P, p.axis);
      const cap = ((ic * ip) / (ic + ip)) * MAX_JOINT_HZ * MAX_JOINT_HZ;
      p.stiffness = Math.min(MUSCLE * Math.min(area(p.half), area(P.half)), cap);
      joint.configureMotorPosition(0, p.stiffness, p.stiffness * 0.08);
      p.joint = joint;
    }

    this.buildBrain(genome);

    this.com = this.centerOfMass();
    this.start = this.com;
    this.m = {
      pathLength: 0, maxClearance: 0, sumClearance: 0, maxTop: 0, sumTop: 0,
      spin: 0, sumEffort: 0, samples: 0, startTargetDist: 0,
    };
  }

  buildBrain(genome) {
    const parts = this.parts;
    for (const p of parts) {
      const node = genome.nodes[p.node];
      p.sig = new Float32Array(N_SENSORS + node.neurons.length);
      p.next = new Float32Array(p.sig.length);
      p.sig[6] = 1;
      p.state = node.neurons.map((n) => ({ phase: n.q * 2 * Math.PI, s: 0, prev: 0 }));
    }
    const resolve = (p, inp) => {
      let src = p;
      if (inp.scope === 1 && p.parent >= 0) src = parts[p.parent];
      else if (inp.scope === 2 && p.children.length) src = parts[p.children[inp.k % p.children.length]];
      else if (inp.scope === 3) src = parts[0];
      return { src, idx: inp.idx % src.sig.length, w: inp.w };
    };
    for (const p of parts) {
      const node = genome.nodes[p.node];
      p.neurons = node.neurons.map((n) => ({ fn: n.fn, p: n.p, inputs: n.inputs.map((i) => resolve(p, i)) }));
      p.effector = resolve(p, node.effector);
    }
  }

  centerOfMass() {
    let x = 0, y = 0, z = 0;
    for (const p of this.parts) {
      const t = p.body.translation();
      x += t.x * p.mass; y += t.y * p.mass; z += t.z * p.mass;
    }
    return [x / this.totalMass, y / this.totalMass, z / this.totalMass];
  }

  // World-space orientation of the box for part i, as [x, y, z, w].
  partRotation(p) {
    const r = p.body.rotation();
    return qmul([r.x, r.y, r.z, r.w], p.rot);
  }

  get done() {
    return this.stepCount >= this.totalSteps || !this.valid;
  }

  step() {
    if (this.done) return false;
    const active = this.stepCount >= this.settle;
    const parts = this.parts;
    const world = this.world;

    for (const p of parts) p.wrot = this.partRotation(p);

    if (active) {
      this.time += DT;
      this.sense();
      this.think();
      let effort = 0, joints = 0;
      for (const p of parts) {
        if (!p.joint) continue;
        const e = p.effector;
        const out = clamp(e.src.sig[e.idx] * e.w, -1, 1);
        p.out = out;
        effort += Math.abs(out);
        joints++;
        // Muscles cannot snap to a new length: the target angle moves at a limited rate.
        const want = (p.lo + p.hi) / 2 + (out * (p.hi - p.lo)) / 2;
        p.aim += clamp(want - p.aim, -SLEW * DT, SLEW * DT);
        p.joint.configureMotorPosition(p.aim, p.stiffness, p.stiffness * 0.08);
      }
      this.m.sumEffort += joints ? effort / joints : 0;
    }

    if (this.env.water) this.applyDrag();

    world.step();
    this.stepCount++;

    // Reject numerical blow-ups.
    for (const p of parts) {
      const v = p.body.linvel();
      const s = Math.hypot(v.x, v.y, v.z);
      if (!(s < MAX_SPEED)) {
        this.valid = false;
        return false;
      }
    }

    const com = this.centerOfMass();
    if (this.stepCount === this.settle || (this.settle === 0 && this.stepCount === 1)) {
      this.start = com;
      if (this.target) this.m.startTargetDist = Math.hypot(...sub(this.target, com));
    } else if (active) {
      this.measure(com);
    }
    this.com = com;
    return !this.done;
  }

  sense() {
    const tgt = this.target;
    for (const p of this.parts) {
      const s = p.sig;
      const q = p.wrot;
      if (p.joint) {
        const a = this.parts[p.parent].body.rotation();
        const b = p.body.rotation();
        const rel = qmul(qconj([a.x, a.y, a.z, a.w]), [b.x, b.y, b.z, b.w]);
        let ang = 2 * Math.atan2(rel[0] * p.axis[0] + rel[1] * p.axis[1] + rel[2] * p.axis[2], rel[3]);
        if (ang > Math.PI) ang -= 2 * Math.PI;
        if (ang < -Math.PI) ang += 2 * Math.PI;
        s[0] = clamp(ang / Math.max(-p.lo, p.hi), -1, 1);
      }
      let touching = 0;
      if (this.ground) {
        this.world.contactPair(this.ground, p.collider, (manifold) => {
          if (manifold.numContacts() > 0) touching = 1;
        });
      }
      s[1] = touching;
      s[2] = qrot(q, [0, 1, 0])[1];
      if (tgt) {
        const t = p.body.translation();
        const d = [tgt[0] - t.x, tgt[1] - t.y, tgt[2] - t.z];
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        const local = qrot(qconj(q), [d[0] / l, d[1] / l, d[2] / l]);
        s[3] = local[0]; s[4] = local[1]; s[5] = local[2];
      }
    }
  }

  think() {
    for (const p of this.parts) {
      const cur = p.sig;
      const next = p.next;
      for (let i = 0; i < N_SENSORS; i++) next[i] = cur[i];
      for (let i = 0; i < p.neurons.length; i++) {
        const n = p.neurons[i];
        const st = p.state[i];
        const [i0, i1, i2] = n.inputs;
        const a = i0.src.sig[i0.idx] * i0.w;
        const b = i1.src.sig[i1.idx] * i1.w;
        const c = i2.src.sig[i2.idx] * i2.w;
        let o;
        switch (n.fn) {
          case 'sum': o = a + b + c; break;
          case 'prod': o = a * b; break;
          case 'thresh': o = a + b + c > 0 ? 1 : -1; break;
          case 'gt': o = a > b ? 1 : -1; break;
          case 'abs': o = Math.abs(a + b); break;
          case 'min': o = Math.min(a, b); break;
          case 'max': o = Math.max(a, b); break;
          case 'if': o = a > 0 ? b : c; break;
          case 'sin': o = Math.sin((a + b) * Math.PI); break;
          case 'tanh': o = Math.tanh(2 * (a + b + c)); break;
          case 'smooth': o = st.s += (a + b + c - st.s) * 0.08; break;
          case 'diff': o = (a - st.prev) * 10; st.prev = a; break;
          case 'wave':
          case 'saw': {
            // Oscillators run at their own frequency; the first input can speed them up or slow them down.
            const hz = (0.3 + 2.7 * n.p) * (1 + 0.5 * clamp(a, -1, 1));
            st.phase += 2 * Math.PI * hz * DT;
            o = n.fn === 'wave' ? Math.sin(st.phase) : ((st.phase / Math.PI) % 2) - 1;
            break;
          }
          default: o = 0;
        }
        next[N_SENSORS + i] = o > 1 ? 1 : o < -1 ? -1 : o === o ? o : 0;
      }
    }
    for (const p of this.parts) {
      const t = p.sig;
      p.sig = p.next;
      p.next = t;
    }
    // Inputs hold references to parts, and read p.sig at use time, so the swap is all that is needed.
  }

  // Viscous water: each patch of surface moving into the water is pushed back
  // in proportion to its area and its speed along its normal. Faces are split
  // into four patches so that spinning is resisted as well as sliding.
  applyDrag() {
    const k = this.env.drag;
    for (const p of this.parts) {
      const body = p.body;
      body.resetForces(true);
      body.resetTorques(true);
      const lv = body.linvel();
      const av = body.angvel();
      const h = p.half;
      const ax = [qrot(p.wrot, [1, 0, 0]), qrot(p.wrot, [0, 1, 0]), qrot(p.wrot, [0, 0, 1])];
      let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
      for (let i = 0; i < 3; i++) {
        const n = ax[i], u = ax[(i + 1) % 3], v = ax[(i + 2) % 3];
        const hu = h[(i + 1) % 3] / 2, hv = h[(i + 2) % 3] / 2;
        const patch = hu * hv * 4; // a quarter of the face
        for (let s = -1; s <= 1; s += 2) {
          for (let c = 0; c < 4; c++) {
            const su = c & 1 ? hu : -hu, sv = c & 2 ? hv : -hv;
            const rx = n[0] * h[i] * s + u[0] * su + v[0] * sv;
            const ry = n[1] * h[i] * s + u[1] * su + v[1] * sv;
            const rz = n[2] * h[i] * s + u[2] * su + v[2] * sv;
            const vx = lv.x + av.y * rz - av.z * ry;
            const vy = lv.y + av.z * rx - av.x * rz;
            const vz = lv.z + av.x * ry - av.y * rx;
            const vn = (vx * n[0] + vy * n[1] + vz * n[2]) * s;
            if (vn <= 0) continue;
            const f = -k * patch * vn * s;
            const Fx = n[0] * f, Fy = n[1] * f, Fz = n[2] * f;
            fx += Fx; fy += Fy; fz += Fz;
            tx += ry * Fz - rz * Fy; ty += rz * Fx - rx * Fz; tz += rx * Fy - ry * Fx;
          }
        }
      }
      body.addForce({ x: fx, y: fy, z: fz }, true);
      body.addTorque({ x: tx, y: ty, z: tz }, true);
    }
  }

  measure(com) {
    const m = this.m;
    const env = this.env;
    m.pathLength += Math.hypot(...sub(com, this.com));
    let low = Infinity, top = -Infinity;
    for (const p of this.parts) {
      const t = p.body.translation();
      const ext = extentY(this.partRotation(p), p.half);
      const g = env.water ? this.start[1] : env.heightAt(t.x, t.z);
      low = Math.min(low, t.y - ext - g);
      top = Math.max(top, t.y + ext - g);
    }
    m.maxClearance = Math.max(m.maxClearance, low);
    m.sumClearance += low;
    m.maxTop = Math.max(m.maxTop, top);
    m.sumTop += top;
    m.spin += this.parts[0].body.angvel().y * DT;
    m.samples++;
  }

  metrics() {
    const m = this.m;
    const n = Math.max(1, m.samples);
    const d = sub(this.com, this.start);
    const water = this.env.water;
    const targetDist = this.target ? Math.hypot(...sub(this.target, this.com)) : 0;
    return {
      distance: water ? Math.hypot(d[0], d[1], d[2]) : Math.hypot(d[0], d[2]),
      pathLength: m.pathLength,
      avgSpeed: m.pathLength / (n * DT),
      dx: d[0], dy: d[1], dz: d[2],
      maxClearance: m.maxClearance,
      avgClearance: m.sumClearance / n,
      maxTop: m.maxTop,
      avgTop: m.sumTop / n,
      approach: this.target ? m.startTargetDist - targetDist : 0,
      targetDist,
      spin: Math.abs(m.spin),
      effort: m.sumEffort / n,
      parts: this.parts.length,
      mass: this.totalMass,
    };
  }

  free() {
    this.world.free();
  }
}

// Moment of inertia of a part about an axis through its centre (creature frame).
function axisInertia(p, axis) {
  const a = qrot(qconj(p.rot), axis);
  const [x, y, z] = p.half;
  return p.arm + (p.mass / 3) * ((y * y + z * z) * a[0] * a[0] + (x * x + z * z) * a[1] * a[1] + (x * x + y * y) * a[2] * a[2]);
}

// Half-height of a rotated box along the world's vertical axis.
function extentY(q, h) {
  const [x, y, z, w] = q;
  return (
    Math.abs(2 * (x * y + w * z)) * h[0] +
    Math.abs(1 - 2 * (x * x + z * z)) * h[1] +
    Math.abs(2 * (y * z - w * x)) * h[2]
  );
}

// Which target positions a goal is tested against in an environment.
export const trialsFor = (env, formula) => (usesTarget(formula) ? env.targets : [null]);

// Run a creature to completion and score it. Metrics are averaged over trials.
export function evaluate(RAPIER, genome, env, formula, goalFn, duration) {
  const trials = trialsFor(env, formula);
  let total = null;
  for (const target of trials) {
    const sim = new Simulation(RAPIER, genome, env, { duration, target });
    while (sim.step());
    const ok = sim.valid;
    const m = sim.metrics();
    sim.free();
    if (!ok) return { fitness: INVALID, metrics: null };
    if (!total) total = m;
    else for (const k in m) total[k] += m[k];
  }
  for (const k in total) total[k] /= trials.length;
  let fitness;
  try {
    fitness = goalFn(total);
  } catch {
    fitness = INVALID;
  }
  return { fitness, metrics: total };
}
