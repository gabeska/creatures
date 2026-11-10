// Fitness-by-generation line chart (best and mean), with a crosshair tooltip.
// Clicking a generation calls onPick(index).

const NS = 'http://www.w3.org/2000/svg';
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export class Chart {
  constructor(el, onPick) {
    this.el = el;
    this.onPick = onPick;
    this.data = [];
    this.selected = -1;
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    new ResizeObserver(() => this.draw()).observe(el);
  }

  update(data, selected) {
    this.data = data;
    this.selected = selected;
    this.draw();
  }

  draw() {
    const el = this.el;
    const data = this.data;
    const W = el.clientWidth || 300;
    const H = el.clientHeight || 170;
    if (data.length === 0) {
      el.innerHTML = '<div class="empty">No generations yet</div>';
      return;
    }
    const L = 34, Rm = 8, T = 8, B = 20;
    const dmin = Math.min(0, ...data.map((d) => Math.min(d.best, d.mean)));
    const dmax = Math.max(...data.map((d) => d.best), dmin + 1e-6);
    // Tick step from a round number, with the axis snapped to whole steps and zero always on a gridline.
    const step = niceMax((dmax - dmin) / 4);
    const lo = Math.floor(dmin / step + 1e-9) * step;
    const hi = Math.max(lo + step, Math.ceil(dmax / step - 1e-9) * step);
    const ticks = Math.round((hi - lo) / step);
    const n = data.length;
    const x = (i) => L + (n === 1 ? (W - L - Rm) / 2 : (i * (W - L - Rm)) / (n - 1));
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const path = (key) => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');

    let s = `<svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Best and mean fitness for each generation">`;
    for (let t = 0; t <= ticks; t++) {
      const v = lo + step * t;
      s += `<line x1="${L}" x2="${W - Rm}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
      s += `<text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
    }
    s += `<line x1="${L}" x2="${W - Rm}" y1="${y(lo)}" y2="${y(lo)}" stroke="var(--line)" stroke-width="1"/>`;
    s += `<text x="${L}" y="${H - 5}">${data[0].gen}</text>`;
    if (n > 1) s += `<text x="${W - Rm}" y="${H - 5}" text-anchor="end">generation ${data[n - 1].gen}</text>`;
    if (this.selected >= 0 && this.selected < n) {
      s += `<line x1="${x(this.selected)}" x2="${x(this.selected)}" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`;
    }
    s += `<path d="${path('mean')}" fill="none" stroke="var(--s2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    s += `<path d="${path('best')}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (n === 1) {
      s += `<circle cx="${x(0)}" cy="${y(data[0].mean)}" r="4" fill="var(--s2)"/><circle cx="${x(0)}" cy="${y(data[0].best)}" r="4" fill="var(--s1)"/>`;
    }
    s += `<g class="hover" visibility="hidden"><line y1="${T}" y2="${H - B}" stroke="var(--ink2)" stroke-width="1"/>`;
    s += `<circle r="4" fill="var(--s2)" stroke="var(--surface)" stroke-width="2"/><circle r="4" fill="var(--s1)" stroke="var(--surface)" stroke-width="2"/></g>`;
    s += '</svg>';
    el.innerHTML = s;
    el.appendChild(this.tip);
    this.tip.hidden = true;

    const svg = el.firstChild;
    const hover = svg.querySelector('.hover');
    const [vline, cMean, cBest] = hover.children;
    const indexAt = (e) => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      if (n === 1) return 0;
      return Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - Rm)) * (n - 1))));
    };
    svg.addEventListener('pointermove', (e) => {
      const i = indexAt(e);
      const d = data[i];
      hover.setAttribute('visibility', 'visible');
      vline.setAttribute('x1', x(i)); vline.setAttribute('x2', x(i));
      cMean.setAttribute('cx', x(i)); cMean.setAttribute('cy', y(d.mean));
      cBest.setAttribute('cx', x(i)); cBest.setAttribute('cy', y(d.best));
      this.tip.innerHTML = `Generation ${d.gen}<br><i style="background:var(--s1)"></i>Best <b>${fmt(d.best)}</b><br><i style="background:var(--s2)"></i>Mean <b>${fmt(d.mean)}</b>`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.max(0, Math.min(W - tw, x(i) + (x(i) > W / 2 ? -tw - 10 : 10)))}px`;
      this.tip.style.top = `${T}px`;
    });
    svg.addEventListener('pointerleave', () => {
      hover.setAttribute('visibility', 'hidden');
      this.tip.hidden = true;
    });
    svg.addEventListener('click', (e) => this.onPick?.(indexAt(e)));
  }
}
