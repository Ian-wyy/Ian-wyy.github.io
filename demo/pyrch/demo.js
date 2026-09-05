/* PyRCH demo — plays back precomputed solutions from data/NNNN.json.
   The site is static, so the C++ solver cannot run here; every plan shown
   was produced offline by PyRCH (see tools/gen_pyrch_demo.py). */

const NS = 'http://www.w3.org/2000/svg';
const W = 100;

const COLOR = { drone: '#1772d0', wheeled: '#e07b1f', legged: '#2f8f7a' };
const NOTE = {
  drone: 'Flies in a straight line over the river and the rocks.',
  wheeled: 'Quick on open ground, but rocks are impassable and the river needs the bridge.',
  legged: 'Slow, yet it is the only ground robot that can walk into the rocks.',
};

const S = {
  data: null,
  seeds: [],
  plan: 'best',      // 'best' | 'first'
  t: 0,              // clock, in solver time units
  playing: false,
  focus: null,
  last: 0,
  routes: [],
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

const fy = (y) => W - y;                     // data y is up, SVG y is down
const path = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
const poly = (pts) => pts.map((p) => p[0].toFixed(2) + ',' + fy(p[1]).toFixed(2)).join(' ');

/* ── robot icons, drawn in a ~9-unit box centred on the origin ── */

function icon(cls, color) {
  const g = document.createElementNS(NS, 'g');
  const stroke = { stroke: '#fff', 'stroke-width': 0.7, 'stroke-linejoin': 'round' };
  if (cls === 'drone') {
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      el('line', { x1: 0, y1: 0, x2: 3.1 * sx, y2: 3.1 * sy, stroke: color, 'stroke-width': 1.1, 'stroke-linecap': 'round' }, g);
      el('circle', { cx: 3.1 * sx, cy: 3.1 * sy, r: 1.9, fill: 'none', stroke: color, 'stroke-width': 0.8, opacity: 0.75 }, g);
    }
    el('circle', { cx: 0, cy: 0, r: 1.7, fill: color, ...stroke }, g);
  } else if (cls === 'wheeled') {
    el('path', { d: 'M-4.2 0.4 L-4.2 -1.5 L-1.9 -1.5 L-0.7 -3.2 L2.4 -3.2 L3.4 -1.5 L4.2 -1.5 L4.2 0.4 Z', fill: color, ...stroke }, g);
    el('circle', { cx: -2.2, cy: 0.9, r: 1.35, fill: '#333', stroke: '#fff', 'stroke-width': 0.6 }, g);
    el('circle', { cx: 2.4, cy: 0.9, r: 1.35, fill: '#333', stroke: '#fff', 'stroke-width': 0.6 }, g);
  } else {
    for (const x of [-2.5, -1.2, 1.2, 2.5]) {
      el('line', { x1: x, y1: -0.6, x2: x + (x < 0 ? -0.5 : 0.5), y2: 2.4, stroke: color, 'stroke-width': 0.95, 'stroke-linecap': 'round' }, g);
    }
    el('rect', { x: -3.4, y: -2.9, width: 6.8, height: 2.6, rx: 1.1, fill: color, ...stroke }, g);
    el('path', { d: 'M3.0 -2.6 L4.6 -3.9 L5.0 -2.2 Z', fill: color, ...stroke }, g);
    el('circle', { cx: 4.2, cy: -3.3, r: 0.9, fill: color, ...stroke }, g);
  }
  return g;
}

function legendIcon(cls) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-6 -6 12 12');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.appendChild(icon(cls, COLOR[cls]));
  return svg;
}

/* ── build the map for the current instance ── */

function buildMap() {
  const d = S.data;
  const svg = $('map');
  svg.textContent = '';

  const gTerr = el('g', {}, svg);
  const gRoute = el('g', {}, svg);
  const gNode = el('g', {}, svg);
  const gAgent = el('g', {}, svg);

  const pat = el('pattern', { id: 'rockpat', width: 3, height: 3, patternUnits: 'userSpaceOnUse' }, el('defs', {}, svg));
  el('rect', { width: 3, height: 3, fill: '#efe9dc' }, pat);
  el('circle', { cx: 1.1, cy: 1.1, r: 0.42, fill: '#d3c6a8' }, pat);
  el('circle', { cx: 2.4, cy: 2.5, r: 0.3, fill: '#d3c6a8' }, pat);

  for (const r of d.terrain.rocks) el('polygon', { points: poly(r), class: 'terr-rock', fill: 'url(#rockpat)' }, gTerr);
  const b = d.terrain.bridge;
  el('polygon', { points: poly(b), class: 'terr-bridge' }, gTerr);
  for (const w of d.terrain.river) el('polygon', { points: poly(w), class: 'terr-water' }, gTerr);
  el('line', { x1: b[0][0], y1: fy(b[0][1]), x2: b[3][0], y2: fy(b[3][1]), class: 'bridge-rail' }, gTerr);
  el('line', { x1: b[1][0], y1: fy(b[1][1]), x2: b[2][0], y2: fy(b[2][1]), class: 'bridge-rail' }, gTerr);
  const bl = el('text', { x: (b[0][0] + b[1][0]) / 2, y: fy((b[0][1] + b[2][1]) / 2) - 5.2, class: 'terrlabel', 'text-anchor': 'middle' }, gTerr);
  bl.textContent = 'BRIDGE';

  // routes (ghost = whole plan, done = travelled so far)
  S.routes = [];
  const sol = S.plan === 'best' ? d.solution : d.first_solution;
  for (const r of sol.routes) {
    const pts = r.poly.map(([x, y]) => [x, fy(y)]);
    const dstr = path(pts);
    const g = el('g', { class: 'route-layer', 'data-cls': r.cls }, gRoute);
    el('path', { d: dstr, class: 'route-casing' }, g);
    el('path', { d: dstr, class: 'route-ghost', stroke: COLOR[r.cls] }, g);
    const done = el('path', { d: dstr, class: 'route-done', stroke: COLOR[r.cls] }, g);
    const L = done.getTotalLength();
    done.setAttribute('stroke-dasharray', L);
    done.setAttribute('stroke-dashoffset', L);

    const ag = el('g', { class: 'agent-layer', 'data-cls': r.cls }, gAgent);
    el('circle', { cx: 0, cy: 0, r: 3.6, fill: '#fff', opacity: 0.8 }, ag);
    ag.appendChild(icon(r.cls, COLOR[r.cls]));

    const speed = d.agents.find((a) => a.cls === r.cls).speed;
    S.routes.push({ ...r, pts, cum: cumulative(pts), done, L, group: g, agent: ag, speed });
  }

  // depot + targets
  const [dx, dy] = d.depot;
  el('path', { d: star(dx, fy(dy), 3.1), fill: '#222' }, gNode);
  const dl = el('text', { x: dx, y: fy(dy) + 5.4, class: 'terrlabel', 'text-anchor': 'middle' }, gNode);
  dl.textContent = 'DEPOT';

  S.marks = {};
  for (const t of d.targets) {
    const x = t.x, y = fy(t.y);
    const m = t.rock
      ? el('path', { d: `M${x} ${y - 1.9} L${x + 1.75} ${y + 1.3} L${x - 1.75} ${y + 1.3} Z`, class: 'tgt' }, gNode)
      : el('circle', { cx: x, cy: y, r: 1.6, class: 'tgt' }, gNode);
    const x1 = el('path', { d: `M${x - 1.5} ${y - 1.5} L${x + 1.5} ${y + 1.5} M${x + 1.5} ${y - 1.5} L${x - 1.5} ${y + 1.5}`, class: 'maskx', opacity: 0 }, gNode);
    S.marks[t.id] = { m, x1, rock: t.rock };
  }
}

function star(cx, cy, r) {
  let s = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.44 : r;
    s += (i ? 'L' : 'M') + (cx + rr * Math.cos(a)).toFixed(2) + ' ' + (cy + rr * Math.sin(a)).toFixed(2);
  }
  return s + 'Z';
}

function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) {
    c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return c;
}

function at(r, dist) {
  const c = r.cum;
  const total = c[c.length - 1];
  const s = Math.max(0, Math.min(dist, total));
  let i = 1;
  while (i < c.length - 1 && c[i] < s) i++;
  const seg = c[i] - c[i - 1] || 1;
  const u = (s - c[i - 1]) / seg;
  const a = r.pts[i - 1], b = r.pts[i];
  return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, dx: b[0] - a[0] };
}

/* ── rail ── */

function buildRail() {
  const d = S.data;
  const rail = $('cards');
  rail.textContent = '';
  const sol = S.plan === 'best' ? d.solution : d.first_solution;
  const maxLen = Math.max(...sol.routes.map((r) => r.length));

  for (const r of sol.routes) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.cls = r.cls;
    const isMax = Math.abs(r.time - sol.makespan) < 1e-6;
    card.innerHTML =
      `<div class="hd"><span class="ico"></span><span class="nm" style="color:${COLOR[r.cls]}">` +
      `${d.agents.find((a) => a.cls === r.cls).label}</span>` +
      `<span class="sp">speed ${r.speed ?? d.agents.find((a) => a.cls === r.cls).speed}&times;</span></div>` +
      `<div class="note">${NOTE[r.cls]}</div>` +
      `<div class="bar${isMax ? ' is-max' : ''}"><span class="lab">time</span><span class="track">` +
      `<span class="fill" style="background:${COLOR[r.cls]};width:${(100 * r.time) / sol.makespan}%"></span></span>` +
      `<span class="val">${r.time.toFixed(0)}</span></div>` +
      `<div class="bar"><span class="lab">distance</span><span class="track">` +
      `<span class="fill" style="background:#c9c9c9;width:${(100 * r.length) / maxLen}%"></span></span>` +
      `<span class="val">${r.length.toFixed(0)}</span></div>` +
      `<div class="bar"><span class="lab">stops</span><span class="track">` +
      `<span class="fill" style="background:#e8e8e8;width:${(100 * (r.path.length - 2)) / d.targets.length}%"></span></span>` +
      `<span class="val">${r.path.length - 2}</span></div>`;
    card.querySelector('.ico').appendChild(legendIcon(r.cls));
    card.addEventListener('mouseenter', () => setFocus(r.cls));
    card.addEventListener('mouseleave', () => setFocus(null));
    rail.appendChild(card);
  }

  $('makespan').textContent = sol.makespan.toFixed(1);
  const gain = d.first_solution.makespan - d.solution.makespan;
  $('anytime').style.display = gain > 0.05 ? '' : 'none';
  $('btn-first').textContent = `first plan · ${d.first_solution.makespan.toFixed(0)}`;
  $('btn-best').textContent = `after ${d.stats.solve_time.toFixed(0)}s · ${d.solution.makespan.toFixed(0)}`;
  $('btn-first').classList.toggle('on', S.plan === 'first');
  $('btn-best').classList.toggle('on', S.plan === 'best');
}

function setFocus(cls) {
  S.focus = cls;
  for (const g of document.querySelectorAll('.route-layer, .agent-layer')) {
    g.classList.toggle('dimmed', !!cls && g.dataset.cls !== cls);
  }
  for (const c of document.querySelectorAll('.card')) {
    c.style.borderColor = cls && c.dataset.cls === cls ? COLOR[cls] : '';
  }
  // reveal what the focused robot is not allowed to serve
  for (const id in S.marks) {
    const mk = S.marks[id];
    const blocked = cls === 'wheeled' && mk.rock;
    mk.x1.setAttribute('opacity', blocked ? 1 : 0);
    mk.m.classList.toggle('masked', blocked);
  }
}

/* ── animation ── */

function duration() {
  return 9.5; // seconds of wall clock for one full replay
}

function tick(ts) {
  if (S.playing) {
    const dt = S.last ? (ts - S.last) / 1000 : 0;
    S.t += (dt * horizon()) / duration();
    if (S.t >= horizon()) {
      S.t = horizon();
      S.playing = false;
      $('btn-play').textContent = '↺ replay';
    }
  }
  S.last = ts;
  draw();
  requestAnimationFrame(tick);
}

function horizon() {
  const sol = S.plan === 'best' ? S.data.solution : S.data.first_solution;
  return sol.makespan;
}

function draw() {
  if (!S.data) return;
  const T = horizon();
  const served = {};
  for (const r of S.routes) {
    const travelled = Math.min(S.t * r.speed, r.cum[r.cum.length - 1]);
    const p = at(r, travelled);
    const flip = p.dx < 0 ? -1 : 1;
    r.agent.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${0.55 * flip} 0.55)`);
    const frac = travelled / (r.cum[r.cum.length - 1] || 1);
    r.done.setAttribute('stroke-dashoffset', (r.L * (1 - frac)).toFixed(2));
    for (let k = 1; k < r.path.length - 1; k++) {
      if (r.stops[k] <= travelled + 1e-6) served[r.path[k]] = r.cls;
    }
  }
  for (const id in S.marks) {
    const c = served[id];
    S.marks[id].m.setAttribute('fill', c ? COLOR[c] : '#fff');
    S.marks[id].m.classList.toggle('served', !!c);
  }
  $('clock').textContent = `t = ${S.t.toFixed(0)} / ${T.toFixed(0)}`;
  const sc = $('scrub');
  if (document.activeElement !== sc) sc.value = String(Math.round((1000 * S.t) / T));
}

/* ── instance loading ── */

async function load(seed) {
  const res = await fetch(`data/${String(seed).padStart(4, '0')}.json`, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`instance ${seed} not found`);
  S.data = await res.json();
  S.plan = 'best';
  S.t = 0;
  buildMap();
  buildRail();
  setFocus(null);
  $('seedtag').textContent = `seed ${seed}`;
  history.replaceState(null, '', `?seed=${seed}`);
  play();
}

function play() {
  S.playing = true;
  S.last = 0;
  if (S.t >= horizon() - 1e-9) S.t = 0;
  $('btn-play').textContent = '⏸ pause';
}

function pause() {
  S.playing = false;
  $('btn-play').textContent = '▶ play';
}

async function main() {
  let manifest;
  try {
    manifest = await (await fetch('data/manifest.json', { cache: 'force-cache' })).json();
  } catch (e) {
    $('stage').innerHTML =
      '<div class="err">Could not load the precomputed instances. ' +
      'If you opened this file directly from disk, serve the folder over HTTP instead ' +
      '(<code>python3 -m http.server</code>).</div>';
    return;
  }
  S.seeds = manifest.seeds;

  const asked = Number(new URLSearchParams(location.search).get('seed'));
  const seed = S.seeds.includes(asked) ? asked : S.seeds[Math.floor(Math.random() * S.seeds.length)];

  $('btn-seed').addEventListener('click', () => {
    let next = S.data ? S.data.seed : -1;
    while (S.seeds.length > 1 && next === (S.data ? S.data.seed : -1)) {
      next = S.seeds[Math.floor(Math.random() * S.seeds.length)];
    }
    load(next);
  });
  $('btn-play').addEventListener('click', () => (S.playing ? pause() : play()));
  $('scrub').addEventListener('input', (e) => {
    pause();
    S.t = (Number(e.target.value) / 1000) * horizon();
  });
  for (const [id, plan] of [['btn-first', 'first'], ['btn-best', 'best']]) {
    $(id).addEventListener('click', () => {
      if (S.plan === plan) return;
      S.plan = plan;
      S.t = 0;
      buildMap();
      buildRail();
      setFocus(S.focus);
      play();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.key.toLowerCase() === 'r') $('btn-seed').click();
  });

  await load(seed);
  requestAnimationFrame(tick);
}

main();
