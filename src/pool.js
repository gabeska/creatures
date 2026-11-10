// A pool of evaluation workers, one per spare CPU core.

const CHUNK = 3;

export class Pool {
  constructor() {
    const n = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 12));
    this.workers = Array.from({ length: n }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
    this.size = n;
    this.run = 0;
  }

  // Scores every creature in `pop` whose fitness is null, in place.
  // Resolves true when all are scored, or false if cancel() was called first.
  evaluate(pop, cfg, onProgress) {
    const run = ++this.run;
    const todo = pop.filter((c) => c.fitness === null);
    let next = 0;
    let finished = 0;
    return new Promise((resolve) => {
      if (todo.length === 0) return resolve(true);
      let busy = 0;
      const feed = (worker) => {
        if (run !== this.run) {
          if (busy === 0) resolve(false);
          return;
        }
        if (next >= todo.length) {
          if (busy === 0) resolve(true);
          return;
        }
        const items = todo.slice(next, next + CHUNK);
        next += items.length;
        busy++;
        worker.onmessage = (e) => {
          busy--;
          e.data.results.forEach((r, i) => Object.assign(items[i], r));
          finished += items.length;
          if (run === this.run) onProgress?.(finished, todo.length);
          feed(worker);
        };
        worker.postMessage({ genomes: items.map((c) => c.genome), ...cfg });
      };
      this.workers.forEach(feed);
    });
  }

  cancel() {
    this.run++;
  }
}
