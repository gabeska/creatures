// Headless evolution run for checking the core without a browser.
// Usage: node test/headless.mjs [env] [goal] [generations] [population]
import RAPIER from '@dimforge/rapier3d-compat';
import { makeRng } from '../src/util.js';
import { ENVS } from '../src/environments.js';
import { GOALS, compileGoal, INVALID } from '../src/goals.js';
import { evaluate } from '../src/sim.js';
import { randomPopulation, nextGeneration, sortByFitness } from '../src/evolve.js';

const [envId = 'land', goalId = 'travel', gens = '15', size = '80'] = process.argv.slice(2);
await RAPIER.init();
const env = ENVS[envId];
const formula = GOALS[goalId]?.formula ?? goalId;
const goalFn = compileGoal(formula);
const rng = makeRng(1);
let pop = randomPopulation(rng, +size);

for (let gen = 0; gen < +gens; gen++) {
  const t0 = performance.now();
  let evals = 0;
  for (const c of pop) {
    if (c.fitness !== null) continue;
    Object.assign(c, evaluate(RAPIER, c.genome, env, formula, goalFn, 8));
    evals++;
  }
  const sorted = sortByFitness(pop);
  const valid = sorted.filter((c) => c.fitness > INVALID);
  const mean = valid.reduce((s, c) => s + c.fitness, 0) / Math.max(1, valid.length);
  const ms = (performance.now() - t0) / Math.max(1, evals);
  console.log(
    `gen ${gen} best ${sorted[0].fitness.toFixed(2)} mean ${mean.toFixed(2)} invalid ${pop.length - valid.length} ` +
      `parts ${sorted[0].metrics?.parts} ${ms.toFixed(1)} ms/eval`
  );
  // Determinism: the champion must score the same when simulated again.
  if (gen === +gens - 1) {
    const again = evaluate(RAPIER, sorted[0].genome, env, formula, goalFn, 8);
    console.log('replay', again.fitness.toFixed(4), 'vs', sorted[0].fitness.toFixed(4), JSON.stringify(again.metrics));
  }
  pop = nextGeneration(sorted, rng, { size: +size });
}
