// Physical simulation of one creature, or of two creatures contesting a cube.
// Used both headless (fitness evaluation in workers) and stepped frame by
// frame by the viewer, so what you watch is exactly what was scored.

import { clamp, qmul, qconj, qrot } from './util.js';
import { N_SENSORS } from './genome.js';
import { develop } from './phenotype.js';
import { terrainMesh } from './environments.js';
import { usesTarget, usesContest, INVALID } from './goals.js';

export const DT = 1 / 60;
export const CUBE_HALF = 0.25;
const SETTLE_STEPS = 90; // let the body come to rest before the brain switches on
const DENSITY = 1;
const MUSCLE = 22; // joint stiffness per unit of cross-section area
const SLEW = 7; // fastest a muscle can change its target angle, rad/s
const MAX_JOINT_HZ = 25; // highest natural frequency a joint spring may have, rad/s
const ARMATURE = 0.3;
const MASS_RATIO = 0.5;
const MAX_SPEED = 15; // anything faster is a physics glitch, not a gait

// Collision groups (membership << 16 | filter). Parts of one creature pass
// through each other, but collide with the ground, the cube and the rival.
const G_GROUND = 0x0001000e;
const G_CREATURE = [0x0002000d, 0x0004000b];
const G_CUBE = 0x00080007;

const terrainCache = new Map();
const IDENT = { x: 0, y: 0, z: 0, w: 1 };
const TURNED = [0, 1, 0, 0]; // half a turn about the vertical axis
const V = (a) => ({ x: a[0], y: a[1], z: a[2] });
const Q = (q) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

export class Simulation {
  // With `opponent` (a genome) the two creatures start either side of a cube.
  constructor(RAPIER, genome, env, { duration = 10, target = null, opponent = null } = {}) {
    this.R = RAPIER;
    this.env = env;
    this.contest = !!opponent;
    this.target = this.contest ? null : target;
    this.settle = env.water ? 0 : SETTLE_STEPS;
    this.totalSteps = this.settle + Math.round(duration / DT);
    this.stepCount = 0;
    this.valid = true;
    this.rivalFailed = false;
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
      this.ground = world.createCollider(desc.setFriction(env.friction).setCollisionGroups(G_GROUND), body);
    }

    this.cube = null;
    if (this.contest) {
      const y = env.terrain ? CUBE_HALF + 0.02 : 0;
      const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(0, y, 0).setCanSleep(false);
      if (env.water) desc.setLinearDamping(1.5).setAngularDamping(1.5);
      this.cube = world.createRigidBody(desc);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(CUBE_HALF, CUBE_HALF, CUBE_HALF).setDensity(DENSITY).setFriction(env.friction).setCollisionGroups(G_CUBE),
        this.cube
      );
    }

    this.creatures = [this.addCreature(genome, 0)];
    if (this.contest) this.creatures.push(this.addCreature(opponent, 1));
    this.parts = this.creatures[0].parts;
    this.allParts = this.creatures.flatMap((c) => c.parts);

    this.com = this.creatures[0].com;
    this.start = this.com;
    this.m = {
      pathLength: 0, maxClearance: 0, sumClearance: 0, maxTop: 0, sumTop: 0,
      spin: 0, sumEffort: 0, samples: 0, startTargetDist: 0,
    };
  }

  addCreature(genome, index) {
    const { R: RAPIER, world, env } = this;
    const parts = develop(genome);

    // Where the creature goes. Alone, it stands at the origin. In a contest
    // each starts on its own side of the cube, set back by at least its own
    // height so that simply falling over cannot reach the cube, and the
    // second one is turned around so both face the cube the same way.
    const box = [0, 1, 2].map((a) => {
      let lo = Infinity, hi = -Infinity;
      for (const p of parts) {
        const e = extent(p.rot, p.half, a);
        lo = Math.min(lo, p.pos[a] - e);
        hi = Math.max(hi, p.pos[a] + e);
      }
      return [lo, hi];
    });
    const offset = [0, 0, 0];
    if (this.contest) {
      const gap = Math.max(1.2, box[1][1] - box[1][0]);
      offset[0] = -(CUBE_HALF + gap) - box[0][1];
      offset[2] = -(box[2][0] + box[2][1]) / 2;
    }
    const turned = index === 1;
    const place = (v) => {
      const w = [v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]];
      return turned ? [-w[0], w[1], -w[2]] : w;
    };
    if (env.terrain) {
      let ground = -Infinity;
      for (const p of parts) {
        const w = place(p.pos);
        ground = Math.max(ground, env.heightAt(w[0], w[2]));
      }
      offset[1] = ground + 0.03 - box[1][0];
    }

    // A light part joined to a heavy one far from the joint makes the solver
    // diverge, so every part gets some extra rotational inertia ("armature")
    // in proportion to what its neighbours hang off it.
    for (const p of parts) {
      p.owner = index;
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

    let totalMass = 0;
    for (const p of parts) {
      const w = place(p.pos);
      p.body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(w[0], w[1], w[2])
          .setRotation(turned ? Q(TURNED) : IDENT)
          .setCanSleep(false)
          .setAngularDamping(0.05)
          .setAdditionalMassProperties(p.extra, { x: 0, y: 0, z: 0 }, { x: p.arm, y: p.arm, z: p.arm }, IDENT)
      );
      p.collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(p.half[0], p.half[1], p.half[2])
          .setRotation(Q(p.rot))
          .setDensity(DENSITY)
          .setFriction(env.friction)
          .setCollisionGroups(G_CREATURE[index]),
        p.body
      );
      totalMass += p.mass;
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
      // All bodies of a creature start with the same orientation, so one axis serves both.
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

    this.buildBrain(parts, genome);
    const creature = { index, parts, totalMass, com: null };
    creature.com = this.centerOfMass(creature);
    return creature;
  }

  buildBrain(parts, genome) {
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

  centerOfMass(creature) {
    let x = 0, y = 0, z = 0;
    for (const p of creature.parts) {
      const t = p.body.translation();
      x += t.x * p.mass; y += t.y * p.mass; z += t.z * p.mass;
    }
    return [x / creature.totalMass, y / creature.totalMass, z / creature.totalMass];
  }

  // World-space orientation of a part's box, as [x, y, z, w].
  partRotation(p) {
    const r = p.body.rotation();
    return qmul([r.x, r.y, r.z, r.w], p.rot);
  }

  cubePosition() {
    const t = this.cube.translation();
    return [t.x, t.y, t.z];
  }

  // What the "target" sensors point at: the cube in a contest, else the light.
  targetPosition() {
    return this.contest ? this.cubePosition() : this.target;
  }

  // The point worth looking at.
  get focus() {
    return this.contest ? this.cubePosition() : this.com;
  }

  get done() {
    return this.stepCount >= this.totalSteps || !this.valid || this.rivalFailed;
  }

  step() {
    if (this.done) return false;
    const active = this.stepCount >= this.settle;
    const world = this.world;

    for (const p of this.allParts) p.wrot = this.partRotation(p);

    if (active) {
      this.time += DT;
      const tgt = this.targetPosition();
      for (const c of this.creatures) {
        const rival = this.contest ? this.creatures[1 - c.index].com : null;
        this.sense(c.parts, tgt, rival);
      }
      for (const c of this.creatures) this.think(c.parts);
      for (const c of this.creatures) {
        let effort = 0, joints = 0;
        for (const p of c.parts) {
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
        if (c.index === 0) this.m.sumEffort += joints ? effort / joints : 0;
      }
    }

    if (this.env.water) this.applyDrag();

    world.step();
    this.stepCount++;

    // Reject numerical blow-ups.
    for (const p of this.allParts) {
      const v = p.body.linvel();
      if (!(Math.hypot(v.x, v.y, v.z) < MAX_SPEED)) {
        if (p.owner === 0) this.valid = false;
        else this.rivalFailed = true;
        return false;
      }
    }

    for (const c of this.creatures) if (c.index > 0) c.com = this.centerOfMass(c);
    const com = this.centerOfMass(this.creatures[0]);
    if (this.stepCount === this.settle || (this.settle === 0 && this.stepCount === 1)) {
      this.start = com;
      const tgt = this.targetPosition();
      if (tgt) this.m.startTargetDist = len(sub(tgt, com));
    } else if (active) {
      this.measure(com);
    }
    this.com = this.creatures[0].com = com;
    return !this.done;
  }

  sense(parts, tgt, rival) {
    const toLocal = (q, from, to) => {
      const d = [to[0] - from.x, to[1] - from.y, to[2] - from.z];
      const l = len(d) || 1;
      return qrot(qconj(q), [d[0] / l, d[1] / l, d[2] / l]);
    };
    for (const p of parts) {
      const s = p.sig;
      const q = p.wrot;
      if (p.joint) {
        const a = parts[p.parent].body.rotation();
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
      if (tgt || rival) {
        const t = p.body.translation();
        if (tgt) {
          const l = toLocal(q, t, tgt);
          s[3] = l[0]; s[4] = l[1]; s[5] = l[2];
        }
        if (rival) {
          const l = toLocal(q, t, rival);
          s[7] = l[0]; s[8] = l[1]; s[9] = l[2];
        }
      }
    }
  }

  think(parts) {
    for (const p of parts) {
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
    // Inputs hold references to parts and read p.sig when used, so swapping the buffers is enough.
    for (const p of parts) {
      const t = p.sig;
      p.sig = p.next;
      p.next = t;
    }
  }

  // Viscous water: each patch of surface moving into the water is pushed back
  // in proportion to its area and its speed along its normal. Faces are split
  // into four patches so that spinning is resisted as well as sliding.
  applyDrag() {
    const k = this.env.drag;
    for (const p of this.allParts) {
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
    m.pathLength += len(sub(com, this.com));
    let low = Infinity, top = -Infinity;
    for (const p of this.parts) {
      const t = p.body.translation();
      const ext = extent(this.partRotation(p), p.half, 1);
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

  // Distance from the cube to the nearest part of a creature.
  reach(creature) {
    const cube = this.cube.translation();
    let best = Infinity;
    for (const p of creature.parts) {
      const t = p.body.translation();
      best = Math.min(best, Math.hypot(t.x - cube.x, t.y - cube.y, t.z - cube.z));
    }
    return best;
  }

  metrics() {
    const m = this.m;
    const n = Math.max(1, m.samples);
    const d = sub(this.com, this.start);
    const water = this.env.water;
    const tgt = this.targetPosition();
    const targetDist = tgt ? len(sub(tgt, this.com)) : 0;
    let cubeDist = 0, rivalCubeDist = 0, control = 0;
    if (this.contest) {
      cubeDist = this.reach(this.creatures[0]);
      rivalCubeDist = this.reach(this.creatures[1]);
      // Sims' contest score: 1 is a draw, 2 is total control, 0 is total defeat.
      control = 1 + (rivalCubeDist - cubeDist) / (rivalCubeDist + cubeDist);
    }
    return {
      distance: water ? len(d) : Math.hypot(d[0], d[2]),
      pathLength: m.pathLength,
      avgSpeed: m.pathLength / (n * DT),
      dx: d[0], dy: d[1], dz: d[2],
      maxClearance: m.maxClearance,
      avgClearance: m.sumClearance / n,
      maxTop: m.maxTop,
      avgTop: m.sumTop / n,
      approach: tgt ? m.startTargetDist - targetDist : 0,
      targetDist,
      control, cubeDist, rivalCubeDist,
      spin: Math.abs(m.spin),
      effort: m.sumEffort / n,
      parts: this.parts.length,
      mass: this.creatures[0].totalMass,
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

// Half-size of a rotated box along world axis a (0 = x, 1 = y, 2 = z).
function extent(q, h, a) {
  const [x, y, z, w] = q;
  const row = a === 0
    ? [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)]
    : a === 1
      ? [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)]
      : [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  return Math.abs(row[0]) * h[0] + Math.abs(row[1]) * h[1] + Math.abs(row[2]) * h[2];
}

// Which target positions a goal is tested against; each is a separate trial.
export const trialsFor = (env, formula) => (usesTarget(formula) && !usesContest(formula) ? env.targets : [null]);

// Run a creature to completion and score it. Metrics are averaged over trials.
// `opponent` is only used when the formula is a contest.
export function evaluate(RAPIER, genome, env, formula, goalFn, duration, opponent = null) {
  const trials = trialsFor(env, formula);
  const rival = usesContest(formula) ? opponent : null;
  let total = null;
  for (const target of trials) {
    const sim = new Simulation(RAPIER, genome, env, { duration, target, opponent: rival });
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
