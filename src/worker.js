// Fitness evaluation worker: simulates batches of creatures off the main thread.
import RAPIER from '@dimforge/rapier3d-compat';
import { ENVS } from './environments.js';
import { compileGoal, INVALID } from './goals.js';
import { evaluate } from './sim.js';

const ready = RAPIER.init();
let cachedFormula = null;
let goalFn = null;

self.onmessage = async (e) => {
  await ready;
  const { batch, genomes, envId, formula, duration } = e.data;
  if (formula !== cachedFormula) {
    goalFn = compileGoal(formula);
    cachedFormula = formula;
  }
  const results = genomes.map((genome) => {
    try {
      return evaluate(RAPIER, genome, ENVS[envId], formula, goalFn, duration);
    } catch (err) {
      return { fitness: INVALID, metrics: null };
    }
  });
  self.postMessage({ batch, results });
};
