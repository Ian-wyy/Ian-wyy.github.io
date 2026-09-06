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

const RATE = 20;      // wall-clock speed-up of the replay
const S = {
  data: null,
  seeds: [],
  seed: null,         // the seed the visitor typed, not the instance's own
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
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
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
  const gLabel = el('g', {}, svg);   // above the routes, below the robots
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
  const blx = Math.min(b[0][0], b[3][0]) - 2;
  const bly = (b[0][1] + b[2][1]) / 2;
  if (Math.hypot(blx - d.depot[0], bly - d.depot[1]) > 14) {  // don't collide with DEPOT
    el('text', { x: blx, y: fy(bly) + 1, class: 'terrlabel', 'text-anchor': 'end' }, gLabel)
      .textContent = 'BRIDGE';
  }

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
    // the clock runs in seconds while the polyline is in layout units
    S.routes.push({ ...r, pts, cum: cumulative(pts), done, L, group: g, agent: ag,
                    upers: speed / d.scale });
  }

  // depot + targets
  const [dx, dy] = d.depot;
  el('path', { d: star(dx, fy(dy), 3.1), fill: '#222' }, gNode);
  const dl = el('text', { x: dx, y: fy(dy) + 5.4, class: 'terrlabel', 'text-anchor': 'middle' }, gLabel);
  dl.textContent = 'DEPOT';

  S.marks = {};
  for (const t of d.targets) {
    const x = t.x, y = fy(t.y);
    const m = t.rock
      ? el('path', { d: `M${x} ${y - 1.9} L${x + 1.75} ${y + 1.3} L${x - 1.75} ${y + 1.3} Z`, class: 'tgt' }, gNode)
      : el('circle', { cx: x, cy: y, r: 1.6, class: 'tgt' }, gNode);
    const x1 = el('path', { d: `M${x - 1.5} ${y - 1.5} L${x + 1.5} ${y + 1.5} M${x + 1.5} ${y - 1.5} L${x - 1.5} ${y + 1.5}`, class: 'maskx' }, gNode);
    x1.style.opacity = 0;
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
  const sol = S.plan === 'best' ? d.solution : d.first_solution;
  const label = (cls) => d.agents.find((a) => a.cls === cls).label;

  // Time and distance are different quantities on different scales, so they get
  // one grouped chart each. Stacking them per robot invited the reader to
  // compare a time bar against a distance bar, which means nothing.
  chart('chart-time', 'travel time (s)', sol.routes, (r) => r.time, label);
  chart('chart-dist', 'distance covered (m)', sol.routes, (r) => r.length, label);

  const rail = $('cards');
  rail.textContent = '';
  for (const r of sol.routes) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.cls = r.cls;
    card.innerHTML =
      `<div class="hd"><span class="ico"></span>` +
      `<span class="nm" style="color:${COLOR[r.cls]}">${label(r.cls)}</span>` +
      `<span class="sp">${d.agents.find((a) => a.cls === r.cls).speed} m/s &middot; ` +
      `${r.path.length - 2} stops</span></div>` +
      `<div class="note">${NOTE[r.cls]}</div>`;
    card.querySelector('.ico').appendChild(legendIcon(r.cls));
    card.addEventListener('mouseenter', () => setFocus(r.cls));
    card.addEventListener('mouseleave', () => setFocus(null));
    rail.appendChild(card);
  }

  $('makespan').textContent = `${sol.makespan.toFixed(0)} s`;
  const gain = d.first_solution.makespan - d.solution.makespan;
  $('anytime').style.display = gain > 0.05 ? '' : 'none';
  $('btn-first').textContent = `first plan \u00b7 ${d.first_solution.makespan.toFixed(0)} s`;
  $('btn-best').textContent = `after ${d.stats.solve_time.toFixed(0)} s \u00b7 ${d.solution.makespan.toFixed(0)} s`;
  $('btn-first').classList.toggle('on', S.plan === 'first');
  $('btn-best').classList.toggle('on', S.plan === 'best');
}

function chart(id, title, routes, value, label) {
  const box = $(id);
  box.textContent = '';
  const top = Math.max(...routes.map(value));
  const hd = document.createElement('div');
  hd.className = 'chart-hd';
  hd.innerHTML = `<b>${title}</b>`;
  box.appendChild(hd);
  for (const r of routes) {
    const v = value(r);
    const row = document.createElement('div');
    row.className = 'crow' + (v >= top - 1e-6 ? ' is-max' : '');
    row.dataset.cls = r.cls;
    row.innerHTML =
      `<span class="nm" style="color:${COLOR[r.cls]}">${label(r.cls)}</span>` +
      `<span class="track"><span class="fill" style="background:${COLOR[r.cls]};width:${(100 * v) / top}%"></span></span>` +
      `<span class="val">${v.toFixed(0)}</span>`;
    row.addEventListener('mouseenter', () => setFocus(r.cls));
    row.addEventListener('mouseleave', () => setFocus(null));
    box.appendChild(row);
  }
}

function setFocus(cls) {
  S.focus = cls;
  for (const g of document.querySelectorAll('.route-layer, .agent-layer')) {
    g.classList.toggle('dimmed', !!cls && g.dataset.cls !== cls);
  }
  for (const c of document.querySelectorAll('.card')) {
    c.style.borderColor = cls && c.dataset.cls === cls ? COLOR[cls] : '';
  }
  for (const row of document.querySelectorAll('.crow')) {
    row.classList.toggle('dim', !!cls && row.dataset.cls !== cls);
  }
  // reveal what the focused robot is not allowed to serve
  for (const id in S.marks) {
    const mk = S.marks[id];
    const blocked = cls === 'wheeled' && mk.rock;
    mk.x1.style.opacity = blocked ? 1 : 0;
    mk.m.classList.toggle('masked', blocked);
  }
}

/* ── animation ── */

function tick(ts) {
  if (S.playing) {
    const dt = S.last ? (ts - S.last) / 1000 : 0;
    S.t += dt * RATE;
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
    const travelled = Math.min(S.t * r.upers, r.cum[r.cum.length - 1]);
    const p = at(r, travelled);
    const flip = p.dx < 0 ? -1 : 1;
    r.agent.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${0.55 * flip} 0.55)`);
    const frac = travelled / (r.cum[r.cum.length - 1] || 1);
    r.done.setAttribute('stroke-dashoffset', (r.L * (1 - frac)).toFixed(2));
    for (let k = 1; k < r.path.length - 1; k++) {
      if (r.arrive[k] <= S.t + 1e-6) served[r.path[k]] = r.cls;
    }
  }
  for (const id in S.marks) {
    const c = served[id];
    S.marks[id].m.style.fill = c ? COLOR[c] : '#fff';
    S.marks[id].m.classList.toggle('served', !!c);
  }
  $('clock').textContent = `${S.t.toFixed(0)} / ${T.toFixed(0)} s`;
  const sc = $('scrub');
  if (document.activeElement !== sc) sc.value = String(Math.round((1000 * S.t) / T));
}

/* ── instance loading ── */

// The visitor types any number; it maps onto one of the shipped instances.
// Which file that is stays an implementation detail.
function pick(seed) {
  const n = S.seeds.length;
  return S.seeds[((seed % n) + n) % n];
}

async function load(seed, tries = 0) {
  const id = pick(seed);
  const res = await fetch(`data/${String(id).padStart(4, '0')}.json`);
  if (!res.ok) {
    // a listing left over from an older build can name an instance that is no
    // longer shipped -- forget it and try the next one rather than dying here
    S.seeds = S.seeds.filter((v) => v !== id);
    if (S.seeds.length && tries < 5) return load(seed, tries + 1);
    throw new Error('no instances available');
  }
  S.data = await res.json();
  S.plan = 'best';
  S.t = 0;
  buildMap();
  buildRail();
  const q = new URLSearchParams(location.search);
  setFocus(COLOR[q.get('focus')] ? q.get('focus') : null);
  S.seed = seed;
  $('seed-input').value = seed;

  // ?at=<0..1> freezes the replay at a fraction of the makespan and ?focus=<cls>
  // isolates one robot -- handy for deep links and for screenshots, since
  // headless virtual time barely advances rAF. Read before replaceState drops them.
  const at = Number(q.get('at'));
  history.replaceState(null, '', `?seed=${seed}`);
  if (at > 0 && at <= 1) {
    S.t = at * horizon();
    pause();
  } else {
    play();
  }
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
    manifest = await (await fetch('data/manifest.json', { cache: 'no-cache' })).json();
  } catch (e) {
    $('stage').innerHTML =
      '<div class="err">Could not load the precomputed instances. ' +
      'If you opened this file directly from disk, serve the folder over HTTP instead ' +
      '(<code>python3 -m http.server</code>).</div>';
    return;
  }
  S.seeds = manifest.seeds;

  const asked = parseInt(new URLSearchParams(location.search).get('seed'), 10);
  const seed = Number.isFinite(asked) && asked >= 0 ? asked : Math.floor(Math.random() * 10000);

  const roll = () => {
    let n, guard = 0;
    do {
      n = Math.floor(Math.random() * 10000);
    } while (++guard < 50 && S.seeds.length > 1 && S.seed !== null && pick(n) === pick(S.seed));
    load(n).catch(() => {});
  };
  $('btn-seed').addEventListener('click', roll);
  $('seed-input').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) load(Math.max(0, Math.min(999999, v))).catch(() => {});
    else e.target.value = S.seed;
  });
  $('seed-input').addEventListener('keydown', (e) => {
    e.stopPropagation();                       // let the field own the space bar
    if (e.key === 'Enter') e.target.blur();
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

  requestAnimationFrame(tick);
  await load(seed).catch(() => load(0)).catch(() => {
    $('stage').innerHTML = '<div class="err">Could not load any instance.</div>';
  });
}

main();
