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
  pop: [],
  gen: 0, // number of completed generations
  history: [], // one entry per completed generation, with its champion
  running: false,
  loop: null,
  formula: GOALS.travel.formula,
  key: '',
  watch: -1, // history index being watched
  rival: null, // in a contest, the champion everyone is scored against
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
    mutationRate: +$('mutation').value,
  };
}

function syncBlurbs() {
  $('envBlurb').textContent = ENVS[$('env').value].blurb;
  const g = GOALS[$('goal').value];
  $('goalBlurb').textContent = g ? g.blurb : 'Your own formula over the measurements below.';
}

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

function newPopulation() {
  state.pop = randomPopulation(state.rng, settings().size);
  state.gen = 0;
  state.history = [];
  state.watch = -1;
  state.rival = null;
  state.key = '';
  $('statusLine').textContent = 'Not started.';
  $('progressBar').style.width = '0';
  refresh();
  showRandom();
}

function showRandom() {
  const s = settings();
  const contest = usesContest(s.formula);
  const opponent = contest ? state.pop[1]?.genome ?? randomViable(state.rng) : null;
  viewer.show({ genome: state.pop[0]?.genome ?? randomViable(state.rng), envId: s.envId, formula: s.formula, duration: s.duration, opponent });
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
    const key = `${s.envId}|${s.formula}|${s.duration}`;
    if (key !== state.key) {
      // The rules changed: old scores no longer apply, but the population carries over.
      for (const c of state.pop) c.fitness = null;
      state.key = key;
    }
    // In a contest everyone meets the previous champion, so scores go stale every generation.
    const contest = usesContest(s.formula);
    const rival = contest ? state.rival ?? state.pop[state.pop.length - 1].genome : null;
    if (contest) for (const c of state.pop) c.fitness = null;
    const t0 = performance.now();
    const pending = state.pop.filter((c) => c.fitness === null).length;
    const done = await pool.evaluate(state.pop, { envId: s.envId, formula: s.formula, duration: s.duration, opponent: rival }, (n, total) => {
      $('progressBar').style.width = `${(100 * n) / total}%`;
      $('statusLine').textContent = `Generation ${state.gen + 1}: simulated ${n} of ${total} creatures on ${pool.size} workers.`;
    });
    if (!done) {
      $('statusLine').textContent = `Paused during generation ${state.gen + 1}.`;
      return;
    }
    const sorted = sortByFitness(state.pop);
    const valid = sorted.filter((c) => c.fitness > INVALID);
    if (valid.length === 0) {
      // Nothing scored at all, which means the formula fails on real data.
      state.running = false;
      $('run').textContent = 'Resume';
      $('statusLine').textContent = 'No creature could be scored. Check the fitness formula.';
      return;
    }
    const mean = valid.reduce((a, c) => a + c.fitness, 0) / valid.length;
    state.gen++;
    state.history.push({
      gen: state.gen, best: sorted[0].fitness, mean,
      genome: sorted[0].genome, metrics: sorted[0].metrics,
      envId: s.envId, formula: s.formula, duration: s.duration, opponent: rival,
    });
    state.rival = sorted[0].genome;
    const rate = pending / ((performance.now() - t0) / 1000);
    $('statusLine').textContent = `Generation ${state.gen} done: ${pending} creatures at ${rate.toFixed(0)} per second.`;
    state.pop = nextGeneration(sorted, state.rng, s);
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
  $('capTitle').textContent = h.opponent
    ? `Generation ${h.gen} champion against the one before it (yellow)`
    : `Champion of generation ${h.gen}`;
  $('capDetail').textContent = `Fitness ${fmt(h.best)} · ${h.metrics?.parts ?? '?'} parts · ${ENVS[h.envId].name} · ${goal ? goal.name : h.formula}`;
  refresh();
}

function refresh() {
  const last = state.history[state.history.length - 1];
  $('statGen').textContent = state.gen;
  $('statBest').textContent = fmt(last?.best);
  $('statMean').textContent = fmt(last?.mean);
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
    app: 'evolved-creatures', version: 1, settings: { ...settings(), goal: $('goal').value },
    gen: state.gen, history: state.history, rival: state.rival, population: state.pop.map((c) => c.genome),
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
    if (data.app !== 'evolved-creatures' || !Array.isArray(data.population) || !data.population.length) throw new Error('not a saved run');
    await pause();
    const s = data.settings ?? {};
    if (ENVS[s.envId]) $('env').value = s.envId;
    if (s.formula && !checkGoal(s.formula)) setFormula(s.formula);
    $('goal').value = Object.entries(GOALS).find(([, g]) => g.formula === state.formula)?.[0] ?? 'custom';
    for (const [id, v] of [['duration', s.duration], ['popSize', s.size], ['mutation', s.mutationRate]]) {
      if ([...$(id).options].some((o) => +o.value === v)) $(id).value = v;
    }
    syncBlurbs();
    state.pop = data.population.map((genome) => ({ genome, fitness: null }));
    state.history = Array.isArray(data.history) ? data.history : [];
    state.gen = data.gen ?? state.history.length;
    state.rival = data.rival ?? null;
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
