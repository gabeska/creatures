// Fitness goals. A goal is a formula over the measurements a simulation
// produces, so a custom goal is just another formula.

export const METRICS = {
  distance: 'straight-line distance the centre of mass ended up from where it started (m)',
  pathLength: 'total length of the path the centre of mass travelled (m)',
  avgSpeed: 'pathLength divided by the trial time (m/s)',
  dx: 'displacement along x (m)',
  dy: 'displacement upward (m)',
  dz: 'displacement along z (m)',
  maxClearance: 'greatest height of the lowest point of the body above the ground (m)',
  avgClearance: 'average height of the lowest point of the body above the ground (m)',
  maxTop: 'greatest height reached by the highest point of the body (m)',
  avgTop: 'average height of the highest point of the body (m)',
  approach: 'how much closer to the target it finished than it started (m)',
  targetDist: 'final distance from the target (m)',
  spin: 'total turning of the root part about the vertical axis (radians)',
  effort: 'average muscle activation, 0 to 1',
  parts: 'number of body parts',
  mass: 'total mass',
};

export const GOALS = {
  travel: { name: 'Travel far', formula: 'distance', blurb: 'Walking or swimming: end up as far from the start as possible.' },
  follow: { name: 'Follow the light', formula: 'approach', blurb: 'Get close to a target; tested with the target in three different places.' },
  jump: { name: 'Jump', formula: 'maxClearance', blurb: 'Get the whole body as high off the ground as possible.' },
  tall: { name: 'Stand tall', formula: 'avgTop', blurb: 'Keep the highest point of the body as high as possible.' },
  spin: { name: 'Spin', formula: 'spin', blurb: 'Turn around the vertical axis as much as possible.' },
  frugal: { name: 'Travel efficiently', formula: 'distance / (0.15 + effort)', blurb: 'Cover distance with as little muscle activity as possible.' },
};

export const usesTarget = (formula) => /\b(approach|targetDist)\b/.test(formula);

// Compiles a formula such as "distance - 0.5 * effort" into a function of the
// metrics object. Math functions (abs, min, max, sqrt, ...) are available.
export function compileGoal(formula) {
  const names = Object.keys(METRICS);
  const mathNames = Object.getOwnPropertyNames(Math);
  const fn = new Function(...mathNames, ...names, `"use strict"; return (${formula});`);
  const mathValues = mathNames.map((n) => Math[n]);
  return (m) => {
    const v = Number(fn(...mathValues, ...names.map((n) => m[n])));
    return Number.isFinite(v) ? v : INVALID;
  };
}

// Returns an error message if the formula does not work, otherwise null.
export function checkGoal(formula) {
  try {
    const sample = Object.fromEntries(Object.keys(METRICS).map((k) => [k, 1]));
    const v = compileGoal(formula)(sample);
    return v === INVALID ? 'Formula did not produce a number' : null;
  } catch (e) {
    return e.message;
  }
}

export const INVALID = -1e9;
