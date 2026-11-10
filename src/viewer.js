// 3D playback of a creature. Runs the same Simulation class the workers use.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Simulation, DT, trialsFor } from './sim.js';
import { ENVS, terrainMesh } from './environments.js';

// One colour per genotype node, so repeated and mirrored segments match.
const PART_COLORS = [0xe8d9b5, 0x6fa8dc, 0xe58a5a, 0x7cc4a0, 0xd9b44a, 0xc98bb9, 0x9a8fe0, 0xd97070];

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#5d6b55';
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 2;
  for (let i = 0; i <= 5; i++) {
    const p = (i * 512) / 5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.moveTo(0, p); g.lineTo(512, p); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.28)';
  g.lineWidth = 6;
  g.strokeRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class Viewer {
  constructor(container, RAPIER) {
    this.R = RAPIER;
    this.container = container;
    this.speed = 1;
    this.sim = null;
    this.spec = null;
    this.pending = null;
    this.trial = 0;
    this.acc = 0;
    this.rest = 0;
    this.envId = null;
    this.onStatus = null;

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    this.camera.position.set(5, 3.5, 6);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 40;
    this.controls.minDistance = 1.5;
    this.controls.target.set(0, 0.6, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4a55, 1.1));
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2.2));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 60 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun, sun.target);

    this.envGroup = new THREE.Group();
    this.bodyGroup = new THREE.Group();
    this.scene.add(this.envGroup, this.bodyGroup);

    this.targetMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe9a0 })
    );
    this.targetMesh.add(new THREE.PointLight(0xffe0a0, 12, 14));
    this.scene.add(this.targetMesh);

    this.gridTex = gridTexture();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.last = performance.now();
    renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // spec: { genome, envId, formula, duration }. With immediate = false the
  // switch waits for the current replay to end, so playback is not cut short.
  show(spec, immediate = true) {
    if (immediate || !this.sim) {
      this.pending = null;
      this.spec = spec;
      this.trial = 0;
      this.restart();
    } else {
      this.pending = spec;
    }
  }

  buildEnv(envId) {
    if (envId === this.envId) return;
    this.envId = envId;
    const env = ENVS[envId];
    const group = this.envGroup;
    for (const o of [...group.children]) {
      group.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    const sky = env.water ? 0x0d3550 : envId === 'moon' ? 0x08090d : envId === 'ice' ? 0xbfd6e6 : 0x9fc4e0;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, env.water ? 12 : 35, env.water ? 55 : 130);

    if (env.water) {
      const n = 12000;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() - 0.5) * 80;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xa8d8f0, size: 0.09, transparent: true, opacity: 0.7 })));
      return;
    }

    const tint = envId === 'moon' ? 0x9a9a9a : envId === 'ice' ? 0xd8ecf8 : 0xffffff;
    const mat = new THREE.MeshStandardMaterial({ map: this.gridTex, color: tint, roughness: envId === 'ice' ? 0.25 : 0.95 });
    let geo;
    if (env.terrain === 'hills') {
      const mesh = terrainMesh(env.heightAt);
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
      const uv = new Float32Array((mesh.vertices.length / 3) * 2);
      for (let i = 0; i < uv.length / 2; i++) {
        uv[i * 2] = mesh.vertices[i * 3] / 5;
        uv[i * 2 + 1] = mesh.vertices[i * 3 + 2] / 5;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      geo.computeVertexNormals();
    } else {
      geo = new THREE.PlaneGeometry(600, 600);
      geo.rotateX(-Math.PI / 2);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 120, uv.getY(i) * 120);
    }
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    group.add(ground);
  }

  restart() {
    const spec = this.spec;
    if (!spec) return;
    this.sim?.free();
    const env = ENVS[spec.envId];
    this.buildEnv(spec.envId);
    const trials = trialsFor(env, spec.formula);
    this.trial %= trials.length;
    const target = trials[this.trial];
    this.sim = new Simulation(this.R, spec.genome, env, { duration: spec.duration, target });
    this.targetMesh.visible = !!target;
    if (target) this.targetMesh.position.set(...target);

    for (const o of [...this.bodyGroup.children]) {
      this.bodyGroup.remove(o);
      o.geometry.dispose();
    }
    this.meshes = this.sim.parts.map((p) => {
      const geo = new THREE.BoxGeometry(p.half[0] * 2, p.half[1] * 2, p.half[2] * 2);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: PART_COLORS[p.node % PART_COLORS.length], roughness: 0.6 })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1a1a19, transparent: true, opacity: 0.55 })));
      this.bodyGroup.add(mesh);
      return mesh;
    });
    this.acc = 0;
    this.rest = 0;
    this.sync();
    // Jump the camera to the creature, keeping the viewing angle.
    const c = this.sim.com;
    const delta = new THREE.Vector3(c[0], c[1], c[2]).sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  sync() {
    const sim = this.sim;
    sim.parts.forEach((p, i) => {
      const t = p.body.translation();
      const q = sim.partRotation(p);
      this.meshes[i].position.set(t.x, t.y, t.z);
      this.meshes[i].quaternion.set(q[0], q[1], q[2], q[3]);
    });
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const sim = this.sim;
    if (sim) {
      if (!sim.done) {
        this.acc += dt * this.speed;
        while (this.acc >= DT && sim.step()) this.acc -= DT;
        this.sync();
      } else {
        this.rest += dt;
        if (this.rest > 0.9) {
          if (this.pending) {
            this.spec = this.pending;
            this.pending = null;
            this.trial = 0;
          } else {
            this.trial++;
          }
          this.restart();
        }
      }
      // Follow the centre of mass.
      const c = this.sim.com;
      const goal = new THREE.Vector3(c[0], c[1], c[2]);
      const delta = goal.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 4));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      this.sun.target.position.copy(this.controls.target);
      this.sun.position.copy(this.controls.target).add(new THREE.Vector3(6, 14, 4));
      this.onStatus?.(this.sim);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
