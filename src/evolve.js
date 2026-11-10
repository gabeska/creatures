// The genetic algorithm: keep the fittest fifth, refill with their offspring.

import { randomGenome, mutate, crossover, graft } from './genome.js';
import { isViable } from './phenotype.js';
import { INVALID } from './goals.js';

export function randomViable(rng) {
  for (;;) {
    const g = randomGenome(rng);
    if (isViable(g)) return g;
  }
}

export function randomPopulation(rng, size) {
  return Array.from({ length: size }, () => ({ genome: randomViable(rng), fitness: null }));
}

// `scored` must be sorted best first. Returns the next population; survivors
// keep their fitness so they are not simulated again.
export function nextGeneration(scored, rng, { size, survival = 0.2, mutationRate = 0.12 }) {
  const keep = Math.max(2, Math.round(size * survival));
  const survivors = scored.filter((c) => c.fitness > INVALID).slice(0, keep);
  while (survivors.length < 2) survivors.push({ genome: randomViable(rng), fitness: null });

  // Rank-weighted choice: better survivors have more offspring.
  const pickParent = () => {
    const r = rng();
    return survivors[Math.floor(r * r * survivors.length)].genome;
  };

  const next = survivors.map((c) => ({ genome: c.genome, fitness: c.fitness, metrics: c.metrics }));
  const fresh = Math.round(size * 0.03);
  while (next.length < size) {
    let child = null;
    if (next.length >= size - fresh) child = randomViable(rng);
    for (let tries = 0; !child && tries < 8; tries++) {
      const r = rng();
      let g;
      if (r < 0.4) g = mutate(pickParent(), rng, mutationRate);
      else if (r < 0.7) g = mutate(crossover(pickParent(), pickParent(), rng), rng, mutationRate * 0.5);
      else g = mutate(graft(pickParent(), pickParent(), rng), rng, mutationRate * 0.5);
      if (isViable(g)) child = g;
    }
    next.push({ genome: child || randomViable(rng), fitness: null });
  }
  return next;
}

export function sortByFitness(pop) {
  return pop.slice().sort((a, b) => b.fitness - a.fitness);
}
