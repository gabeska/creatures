import RAPIER from '@dimforge/rapier3d-compat';
import { makeRng } from './util.js';
import { ENVS } from './environments.js';
import { GOALS, METRICS, checkGoal, usesContest, INVALID } from './goals.js';
import { randomPopulation, randomViable, nextGeneration, sortByFitness } from './evolve.js';
import { Pool } from './pool.js';
import { Viewer } from './viewer.js';
import { Chart } from './chart.js';

const $ = (id) => document.getElementById(id);
const fmt = (v) => (v == null || v <= INVALID ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

const state = {
  rng: makeRng((Math.random() * 2 ** 32) >>> 0),
  islands: [], // separate populations, each { pop, rival }
  gen: 0, // number of completed generations
  history: [], // one entry per completed generation, with its champion
  running: false,
  loop: null,
  formula: GOALS.travel.formula,
  key: '',
  watch: -1, // history index being watched
};

await RAPIER.init();
const pool = new Pool();
const viewer = new Viewer($('view'), RAPIER);
const chart = new Chart($('chart'), (i) => watch(i, true));

// ---------- controls ----------

for (const [id, e] of Object.entries(ENVS)) $('env').add(new Option(e.name, id));
for (const [id, g] of Object.entries(GOALS)) $('goal').add(new Option(g.name, id));
$('goal').add(new Option('Custom formula', 'custom'));
$('metricList').innerHTML = Object.entries(METRICS).map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');

function settings() {
  return {
    envId: $('env').value,
    formula: state.formula,
    duration: +$('duration').value,
    size: +$('popSize').value,
    islands: +$('islands').value,
    mutationRate: +$('mutation').value,
  };
}

function syncBlurbs() {
  $('envBlurb').textContent = ENVS[$('env').value].blurb;
  const g = GOALS[$('goal').value];
  $('goalBlurb').textContent = g ? g.blurb : 'Your own formula over the measurements below.';
  const s = settings();
  const per = perIsland(s);
  $('islandHint').textContent =
    s.islands === 1
      ? 'One population. More islands keep separate lines of creatures going, which helps long runs.'
      : usesContest(s.formula)
        ? `${s.islands} species of ${per}. Each fights the champion of the next species, and they never interbreed.`
        : `${s.islands} islands of ${per} evolve apart. Every ${MIGRATE_EVERY} generations each sends a copy of its best to the next.`;
}

$('islands').onchange = syncBlurbs;
$('popSize').onchange = syncBlurbs;

$('env').onchange = () => {
  syncBlurbs();
  if (!state.history.length) showRandom(); // preview the new world before the first generation
};
$('goal').onchange = () => {
  const g = GOALS[$('goal').value];
  if (g) setFormula(g.formula);
  syncBlurbs();
  if (!state.history.length) showRandom();
};
$('formula').oninput = () => {
  const text = $('formula').value.trim();
  const err = text ? checkGoal(text) : 'Enter a formula';
  $('formulaError').hidden = !err;
  $('formulaError').textContent = err ? `${err}. Still using: ${state.formula}` : '';
  if (err) return;
  state.formula = text;
  const match = Object.entries(GOALS).find(([, g]) => g.formula === text);
  $('goal').value = match ? match[0] : 'custom';
  syncBlurbs();
};
function setFormula(f) {
  state.formula = f;
  $('formula').value = f;
  $('formulaError').hidden = true;
}

$('speed').onchange = () => (viewer.speed = +$('speed').value);
$('follow').onchange = () => {
  if ($('follow').checked && state.history.length) watch(state.history.length - 1, true);
};
$('scrub').oninput = () => watch(+$('scrub').value, true);

$('run').onclick = () => (state.running ? pause() : start());
$('reset').onclick = async () => {
  await pause();
  newPopulation();
};

// ---------- evolution ----------

const MIGRATE_EVERY = 10;
const perIsland = (s) => Math.max(10, Math.round(s.size / s.islands));
const everyone = () => state.islands.flatMap((i) => i.pop);

// Make sure there are n islands, dealing the existing creatures out again if the number changed.
function regroup(n) {
  if (state.islands.length === n) return;
  const all = everyone();
  const old = state.islands;
  state.islands = Array.from({ length: n }, (_, k) => ({ pop: [], rival: old[k]?.rival ?? null }));
  all.forEach((c, i) => state.islands[i % n].pop.push(c));
}

function newPopulation() {
  const s = settings();
  state.islands = Array.from({ length: s.islands }, () => ({ pop: randomPopulation(state.rng, perIsland(s)), rival: null }));
  state.gen = 0;
  state.history = [];
  state.watch = -1;
  state.key = '';
  $('statusLine').textContent = 'Not started.';
  $('progressBar').style.width = '0';
  refresh();
  showRandom();
}

function showRandom() {
  const s = settings();
  const contest = usesContest(s.formula);
  const pop = state.islands[0]?.pop ?? [];
  const opponent = contest ? pop[1]?.genome ?? randomViable(state.rng) : null;
  viewer.show({ genome: pop[0]?.genome ?? randomViable(state.rng), envId: s.envId, formula: s.formula, duration: s.duration, opponent });
  $('capTitle').textContent = contest ? 'Two random creatures' : 'A random creature';
  $('capDetail').textContent = 'Generation 0 is all random. Start evolving to improve on it.';
}

function start() {
  if (state.running) return;
  state.running = true;
  $('run').textContent = 'Pause';
  state.loop = (state.loop ?? Promise.resolve()).then(evolveLoop);
}

function pause() {
  state.running = false;
  pool.cancel();
  $('run').textContent = state.gen ? 'Resume' : 'Start evolving';
  return state.loop;
}

async function evolveLoop() {
  while (state.running) {
    const s = settings();
    regroup(s.islands);
    const islands = state.islands;
    const n = islands.length;
    const key = `${s.envId}|${s.formula}|${s.duration}`;
    if (key !== state.key) {
      // The rules changed: old scores no longer apply, but the population carries over.
      for (const c of everyone()) c.fitness = null;
      state.key = key;
    }
    // In a contest everyone meets a previous champion, so scores go stale every
    // generation. One island fights its own last champion; several islands are
    // separate species, each fighting the last champion of the next one.
    const contest = usesContest(s.formula);
    islands.forEach((island, k) => {
      const source = islands[(k + (n > 1 ? 1 : 0)) % n];
      const rival = contest ? source.rival ?? source.pop[source.pop.length - 1].genome : null;
      for (const c of island.pop) {
        c.opponent = rival;
        if (contest) c.fitness = null;
      }
    });
    const all = everyone();
    const t0 = performance.now();
    const pending = all.filter((c) => c.fitness === null).length;
    const done = await pool.evaluate(all, { envId: s.envId, formula: s.formula, duration: s.duration }, (n, total) => {
      $('progressBar').style.width = `${(100 * n) / total}%`;
      $('statusLine').textContent = `Generation ${state.gen + 1}: simulated ${n} of ${total} creatures on ${pool.size} workers.`;
    });
    if (!done) {
      $('statusLine').textContent = `Paused during generation ${state.gen + 1}.`;
      return;
    }
    const sorted = islands.map((island) => sortByFitness(island.pop));
    const valid = all.filter((c) => c.fitness > INVALID);
    if (valid.length === 0) {
      // Nothing scored at all, which means the formula fails on real data.
      state.running = false;
      $('run').textContent = 'Resume';
      $('statusLine').textContent = 'No creature could be scored. Check the fitness formula.';
      return;
    }
    const mean = valid.reduce((a, c) => a + c.fitness, 0) / valid.length;
    state.gen++;
    let top = 0;
    sorted.forEach((list, k) => {
      if (list[0].fitness > sorted[top][0].fitness) top = k;
    });
    const champion = sorted[top][0];
    state.history.push({
      gen: state.gen, best: champion.fitness, mean,
      genome: champion.genome, metrics: champion.metrics,
      envId: s.envId, formula: s.formula, duration: s.duration, opponent: champion.opponent ?? null,
      island: top, islandBest: sorted.map((list) => list[0].fitness),
    });
    const rate = pending / ((performance.now() - t0) / 1000);
    $('statusLine').textContent = `Generation ${state.gen} done: ${pending} creatures at ${rate.toFixed(0)} per second.`;
    islands.forEach((island, k) => (island.rival = sorted[k][0].genome));

    // Migration: now and then each island's best displaces the worst on the
    // next island. Contest species stay separate.
    if (n > 1 && !contest && state.gen % MIGRATE_EVERY === 0) {
      const bests = sorted.map((list) => list[0]);
      sorted.forEach((list, k) => {
        const m = bests[(k + n - 1) % n];
        list[list.length - 1] = { genome: m.genome, fitness: m.fitness, metrics: m.metrics };
        sorted[k] = sortByFitness(list);
      });
    }
    islands.forEach((island, k) => (island.pop = nextGeneration(sorted[k], state.rng, { ...s, size: perIsland(s) })));
    if ($('follow').checked || state.watch < 0) watch(state.history.length - 1, false);
    refresh();
  }
}

// ---------- watching ----------

function watch(i, byUser) {
  const h = state.history[i];
  if (!h) return;
  const prev = state.history[state.watch];
  const latest = i === state.history.length - 1;
  if (byUser) $('follow').checked = latest;
  state.watch = i;
  // An unchanged champion keeps playing rather than restarting.
  if (byUser || !prev || prev.genome !== h.genome || prev.opponent !== h.opponent || prev.envId !== h.envId || prev.formula !== h.formula) {
    viewer.show({ genome: h.genome, envId: h.envId, formula: h.formula, duration: h.duration, opponent: h.opponent }, byUser);
  }
  const goal = Object.values(GOALS).find((g) => g.formula === h.formula);
  const many = (h.islandBest?.length ?? 1) > 1;
  $('capTitle').textContent = h.opponent
    ? many
      ? `Generation ${h.gen} champion against a rival species' champion (yellow)`
      : `Generation ${h.gen} champion against the one before it (yellow)`
    : `Champion of generation ${h.gen}`;
  $('capDetail').textContent =
    `Fitness ${fmt(h.best)} · ${h.metrics?.parts ?? '?'} parts · ${ENVS[h.envId].name} · ${goal ? goal.name : h.formula}` +
    (many ? ` · island ${h.island + 1} of ${h.islandBest.length}` : '');
  refresh();
}

function refresh() {
  const last = state.history[state.history.length - 1];
  $('statGen').textContent = state.gen;
  $('statBest').textContent = fmt(last?.best);
  $('statMean').textContent = fmt(last?.mean);
  const perIslandBest = last?.islandBest ?? [];
  $('islandLine').hidden = perIslandBest.length < 2;
  $('islandLine').textContent = `Best on each island: ${perIslandBest.map(fmt).join(' · ')}`;
  const scrub = $('scrub');
  scrub.disabled = state.history.length < 2;
  scrub.max = Math.max(0, state.history.length - 1);
  scrub.value = Math.max(0, state.watch);
  $('scrubLabel').textContent = state.watch >= 0 ? `Gen ${state.history[state.watch].gen} of ${state.gen}` : '–';
  chart.update(state.history, state.watch);
}

// ---------- save / load ----------

$('save').onclick = () => {
  const data = {
    app: 'evolved-creatures', version: 2, settings: { ...settings(), goal: $('goal').value },
    gen: state.gen, history: state.history,
    islands: state.islands.map((i) => ({ rival: i.rival, population: i.pop.map((c) => c.genome) })),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `creatures-${data.settings.envId}-gen${state.gen}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('load').onclick = () => $('loadFile').click();
$('loadFile').onchange = async () => {
  const file = $('loadFile').files[0];
  $('loadFile').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // Version 1 files hold a single population.
    const saved = data.islands ?? [{ rival: data.rival ?? null, population: data.population }];
    if (data.app !== 'evolved-creatures' || !saved.every((i) => Array.isArray(i.population) && i.population.length)) throw new Error('not a saved run');
    await pause();
    const s = data.settings ?? {};
    if (ENVS[s.envId]) $('env').value = s.envId;
    if (s.formula && !checkGoal(s.formula)) setFormula(s.formula);
    $('goal').value = Object.entries(GOALS).find(([, g]) => g.formula === state.formula)?.[0] ?? 'custom';
    for (const [id, v] of [['duration', s.duration], ['popSize', s.size], ['mutation', s.mutationRate], ['islands', saved.length]]) {
      if ([...$(id).options].some((o) => +o.value === v)) $(id).value = v;
    }
    syncBlurbs();
    state.islands = saved.map((i) => ({ rival: i.rival ?? null, pop: i.population.map((genome) => ({ genome, fitness: null })) }));
    state.history = Array.isArray(data.history) ? data.history : [];
    state.gen = data.gen ?? state.history.length;
    state.key = '';
    state.watch = -1;
    $('run').textContent = 'Resume';
    $('statusLine').textContent = `Loaded ${file.name}.`;
    if (state.history.length) watch(state.history.length - 1, true);
    else showRandom();
    refresh();
  } catch (e) {
    $('statusLine').textContent = `Could not load that file: ${e.message}.`;
  }
};

// ---------- go ----------

setFormula(GOALS.travel.formula);
syncBlurbs();
newPopulation();
