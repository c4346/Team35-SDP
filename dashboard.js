/* =====================================================================
   Setup
   ===================================================================== */

const $ = (selector) => document.querySelector(selector);

const HISTORY_LENGTH = 600;          // samples kept per channel for traces (30 s at 20 Hz)
const RAW_LINES_SHOWN = 8;
const STALE_AFTER_MS = 1000;

// 270° arc used by every gauge.
const GAUGE_ARC = 'M30.72 140A80 80 0 1 1 169.28 140';

// Display channels. `hi` / `lo` are alarm thresholds; `decimals` is display precision.
// `view` picks how a channel is drawn:
//   (none)  270° dial                     'bar'   vertical bar with a latched peak marker
//   'gear'  big gear number + N–6 strip   'fuel'  horizontal E→F gradient bar
//   'tyre'  full-circle ring; every tyre channel shares one card, laid out like the car
//   'trace' full-width scrolling line chart
// `big: true` makes a dial or fuel gauge span two grid columns.
const CHANNELS = [
  { key: 'rpm', name: 'Engine speed',  unit: 'rpm', min: 0,  max: 12000, hi: 10500, decimals: 0, big: true },
  { key: 'spd', name: 'Vehicle speed', unit: 'mph', min: 0,  max: 80,               decimals: 0, big: true },
  { key: 'gear', name: 'Gear',         unit: '',    min: 0,  max: 6,                decimals: 0, view: 'gear' },
  { key: 'tfl', name: 'Front left',    unit: 'psi', min: 0,  max: 40,    lo: 22, hi: 36, decimals: 1, view: 'tyre', pos: 'FL' },
  { key: 'tfr', name: 'Front right',   unit: 'psi', min: 0,  max: 40,    lo: 22, hi: 36, decimals: 1, view: 'tyre', pos: 'FR' },
  { key: 'trl', name: 'Rear left',     unit: 'psi', min: 0,  max: 40,    lo: 22, hi: 36, decimals: 1, view: 'tyre', pos: 'RL' },
  { key: 'trr', name: 'Rear right',    unit: 'psi', min: 0,  max: 40,    lo: 22, hi: 36, decimals: 1, view: 'tyre', pos: 'RR' },
  { key: 'thr', name: 'Throttle',      unit: '%',   min: 0,  max: 100,              decimals: 0 },
  { key: 'brk', name: 'Brake pressure', unit: 'psi', min: 0, max: 1200,             decimals: 0, view: 'bar' },
  { key: 'fuel', name: 'Fuel level',   unit: '%',   min: 0,  max: 100,   lo: 15,    decimals: 0, view: 'fuel', big: true },
  { key: 'clt', name: 'Coolant temp',  unit: '°C',  min: 40, max: 130,   hi: 105,   decimals: 0, view: 'trace' },
  { key: 'bat', name: 'Battery',       unit: 'V',   min: 10, max: 14.6,  lo: 11.5,  decimals: 1 },
  { key: 'oil', name: 'Oil pressure',  unit: 'psi', min: 0,  max: 90,    lo: 15,    decimals: 0 },
];

for (const ch of CHANNELS) {
  ch.value = 0;
  ch.history = [];
  ch.peak = null;                    // highest value since the page was opened
}

const SIGNAL_MAP = JSON.parse($('#channel-file').textContent);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (ch, v) => v.toFixed(ch.decimals);

/** Returns 'bad', 'warn', or '' for a channel value. */
function statusOf(ch, v) {
  const overHi = ch.hi != null && v >= ch.hi;
  const underLo = ch.lo != null && v <= ch.lo;
  if (overHi || underLo) return 'bad';

  const nearHi = ch.hi != null && v >= ch.hi * 0.93;
  const nearLo = ch.lo != null && v <= ch.lo * 1.1;
  if (nearHi || nearLo) return 'warn';

  return '';
}

const statusColor = (s) => (s === 'bad' ? 'var(--bad)' : s === 'warn' ? 'var(--warn)' : 'var(--ok)');

/* =====================================================================
   Build the DOM: cards in channel order, then full-width traces
   ===================================================================== */

const byView = (view) => CHANNELS.filter((ch) => (ch.view ?? 'dial') === view);
const DIAL_CHANNELS = byView('dial');
const BAR_CHANNELS = byView('bar');
const GEAR_CHANNELS = byView('gear');
const FUEL_CHANNELS = byView('fuel');
const TYRE_CHANNELS = byView('tyre');
const TRACE_CHANNELS = byView('trace');

const gearLabel = (g) => (Math.round(g) === 0 ? 'N' : String(Math.round(g)));

// Arc fill colour runs green → amber → red from the left end of the dial to the right.
// Channels that only alarm when LOW (battery, oil) are reversed so red is always the danger end.
const ARC_STOPS = ['var(--ok)', 'var(--mid)', 'var(--warn)', 'var(--bad)'];
const gradientStops = (ch) => (ch.lo != null && ch.hi == null ? [...ARC_STOPS].reverse() : ARC_STOPS);

const arcGradient = (ch) => {
  const stops = gradientStops(ch);
  return `
    <linearGradient id="grad-${ch.key}" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="180" y2="0">
      ${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" style="stop-color:${c}"/>`).join('')}
    </linearGradient>`;
};

const dialCard = (ch) => `
  <div class="card${ch.big ? ' big' : ''}">
    <h3>${ch.name}</h3>
    <svg class="gauge" id="gauge-${ch.key}" viewBox="0 0 200 170">
      <path class="track" pathLength="100" d="${GAUGE_ARC}"/>
      <defs>${arcGradient(ch)}</defs>
      <path class="fill"  pathLength="100" d="${GAUGE_ARC}" stroke-dasharray="0 100" stroke="url(#grad-${ch.key})"/>
      <text class="value" x="100" y="112">0</text>
      <text class="unit"  x="100" y="132">${ch.unit}</text>
      <text class="limit" x="36"  y="162">${ch.min}</text>
      <text class="limit" x="164" y="162">${ch.max}</text>
    </svg>
  </div>`;

const barCard = (ch) => `
  <div class="card bar-card">
    <h3>${ch.name}</h3>
    <div class="bar" id="bar-${ch.key}">
      <div class="bar-scale"><span>${ch.max}</span><span>${ch.max / 2}</span><span>${ch.min}</span></div>
      <div class="bar-track">
        <div class="bar-fill"></div>
        <div class="bar-peak"></div>
      </div>
      <div class="bar-readout">
        <b class="bar-value">0</b>
        <span>${ch.unit}</span>
        <small class="bar-peak-label">peak 0</small>
      </div>
    </div>
  </div>`;

const gearCard = (ch) => `
  <div class="card gear-card" id="gear-${ch.key}">
    <h3>${ch.name}</h3>
    <b class="gear-value">N</b>
    <div class="gear-strip">
      ${Array.from({ length: ch.max + 1 }, (_, g) => `<span>${gearLabel(g)}</span>`).join('')}
    </div>
  </div>`;

const fuelCard = (ch) => `
  <div class="card fuel-card${ch.big ? ' big' : ''}" id="fuel-${ch.key}">
    <h3>${ch.name}</h3>
    <b class="fuel-value">0<small>${ch.unit}</small></b>
    <div class="fuel-bar" style="--grad: linear-gradient(90deg, ${gradientStops(ch).join(', ')})"></div>
    <div class="fuel-scale"><span>E</span><span>½</span><span>F</span></div>
  </div>`;

// Full 360° ring, starting at 12 o'clock and filling clockwise. The ring itself is a CSS
// conic gradient (green → red around the circle) on .ring-band; the SVG only holds the text.
const tyreRing = (ch) => `
  <div class="ring" id="ring-${ch.key}" aria-label="${ch.name} tyre pressure">
    <div class="ring-band"></div>
    <svg viewBox="0 0 120 120">
      <text class="pos"   x="60" y="44">${ch.pos}</text>
      <text class="value" x="60" y="72">0</text>
      <text class="unit"  x="60" y="88">${ch.unit}</text>
    </svg>
  </div>`;

const tyreCard = (tyres) => `
  <div class="card tyre-card big">
    <h3>Tyre pressure</h3>
    <div class="tyre-front">▲ Front</div>
    <div class="tyre-grid">${tyres.map(tyreRing).join('')}</div>
  </div>`;

const traceCard = (ch) => `
  <div class="card trace-card">
    <div class="trace-head">
      <h3>${ch.name} <span class="trace-span">· last ${HISTORY_LENGTH / 20} s</span></h3>
      <b id="trace-value-${ch.key}"></b>
    </div>
    <canvas id="trace-canvas-${ch.key}"></canvas>
  </div>`;

const CARD_BUILDERS = { dial: dialCard, bar: barCard, gear: gearCard, fuel: fuelCard };

$('#gauge-grid').innerHTML =
  CHANNELS.map((ch) => {
    const view = ch.view ?? 'dial';
    if (view === 'tyre') return ch === TYRE_CHANNELS[0] ? tyreCard(TYRE_CHANNELS) : '';
    return CARD_BUILDERS[view]?.(ch) ?? '';
  }).join('') + TRACE_CHANNELS.map(traceCard).join('');

/* =====================================================================
   Real side — this part stays when the fake source is swapped for USB
   ===================================================================== */

const link = {
  frames: 0,
  framesLastSecond: 0,
  rate: 0,
  crcErrors: 0,
  missed: 0,
  lastFrameAt: performance.now(),
};

const rawLines = [];

/** Store decoded values into channels. */
function feed(values) {
  for (const ch of CHANNELS) {
    const v = values[ch.key];
    if (v == null) continue;

    ch.value = v;
    ch.history.push(v);
    if (ch.history.length > HISTORY_LENGTH) ch.history.shift();
    ch.peak = ch.peak == null ? v : Math.max(ch.peak, v);
  }
  link.frames++;
  link.lastFrameAt = performance.now();
}

/** Decode one CAN frame ({ id, d: hex string }) into named values, or null if unknown. */
function decodeFrame(frame) {
  const signals = SIGNAL_MAP['0x' + frame.id.toString(16)];
  if (!signals) return null;

  const bytes = frame.d.match(/../g).map((h) => parseInt(h, 16));
  const out = {};

  for (const sig of signals) {
    // Little-endian unsigned read
    let raw = 0;
    for (let i = sig.bytes - 1; i >= 0; i--) raw = raw * 256 + bytes[sig.start + i];

    if (sig.signed && raw >= 2 ** (8 * sig.bytes - 1)) raw -= 2 ** (8 * sig.bytes);

    out[sig.name] = raw * sig.scale + sig.offset;
  }
  return out;
}

/** Entry point for every text line from the base station. */
function onLine(text) {
  // Raw feed panel is optional (commented out in dashboard.html); skip it when absent.
  const rawFeed = $('#raw-feed');
  if (rawFeed) {
    rawLines.push(text);
    if (rawLines.length > RAW_LINES_SHOWN) rawLines.shift();
    rawFeed.textContent = rawLines.join('\n');
  }

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  if (msg.stat) {
    link.crcErrors = msg.stat.bad_crc;
    link.missed = msg.stat.missed;
    return;
  }

  const values = decodeFrame(msg);
  if (values) feed(values);
}

/* =====================================================================
   Fake side — pretends to be the base ESP32 printing one JSON line
   per CAN frame. Delete this block when a real reader is wired up.
   ===================================================================== */

const sim = { t: 0, throttle: 0, speed: 0, seq: 0, good: 0, bad: 0, missed: 0, dropped: false };

const toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
const pad8 = (bytes) => bytes.concat(Array(8 - bytes.length).fill(0));
const u16le = (v) => {
  v = Math.max(0, Math.round(v));
  return [v & 255, (v >> 8) & 255];
};

/** Emit one frame, randomly simulating CRC failures and missed frames. */
function emitFrame(id, bytes) {
  const r = Math.random();
  if (r < 0.004) { sim.bad++; return; }
  if (r < 0.007) { sim.missed++; sim.seq++; return; }

  sim.seq++;
  sim.good++;
  onLine(JSON.stringify({
    t: Math.round(performance.now()),
    seq: sim.seq & 255,
    id,
    d: toHex(pad8(bytes)),
  }));
}

function fakeTick() {
  sim.t += 0.05;
  const t = sim.t;

  const pedal = 55 + 48 * Math.sin(t * 0.9) + 14 * Math.sin(t * 3.1);
  sim.throttle = clamp(pedal, 0, 100);
  const brake = pedal < 10 ? clamp((10 - pedal) * 60 + Math.random() * 25, 0, 1200) : 0;
  sim.speed += (8 + sim.throttle * 0.62 - sim.speed) * 0.04;
  sim.speed = Math.max(0, sim.speed - brake * 0.0004);

  // Gear from road speed: N when stopped, then up-shift points in mph.
  const gear = sim.speed < 1 ? 0 : 1 + [12, 22, 34, 46, 60].filter((s) => sim.speed >= s).length;

  // Fuel burns with throttle; small random slosh on top.
  sim.fuel = Math.max(0, (sim.fuel ?? 85) - (0.002 + sim.throttle * 0.00006));
  const fuel = clamp(sim.fuel + (Math.random() - 0.5) * 0.8, 0, 100);

  // Tyres warm up a little; rear-right has a slow leak so the alarm shows.
  const warm = Math.min(3, t * 0.01);
  const tyre = (base, leak) => clamp(base + warm - t * leak + (Math.random() - 0.5) * 0.2, 0, 40);
  const tyres = [tyre(28, 0), tyre(28.4, 0), tyre(27.6, 0), tyre(28, 0.012)];

// these are what make the dials move in a realistic way, they will be removed when the real ESP32 is connected 

  const baseRpm = 1800 + sim.speed * 112;
  const rpm     = baseRpm + sim.throttle * 14 + Math.random() * 80;
  const coolant = 82 + Math.min(30, t * 0.03) + sim.throttle * 0.05 + Math.random() * 0.4;
  const battery = 13.6 - sim.throttle * 0.012 + Math.random() * 0.04;
  const oil     = 20 + baseRpm * 0.0055 + Math.random() * 1.5;

  emitFrame(0x100, [...u16le(rpm), ...u16le(sim.speed * 10), Math.round(sim.throttle), ...u16le(brake), gear]);
  emitFrame(0x101, [...u16le((coolant + 40) * 10), ...u16le(battery * 1000), ...u16le(oil * 10)]);
  emitFrame(0x102, [Math.round(fuel * 2), ...tyres.map((p) => Math.round(p * 5))]);
}

setInterval(() => {
  if (!sim.dropped) fakeTick();
}, 50);

setInterval(() => {
  link.rate = link.frames - link.framesLastSecond;
  link.framesLastSecond = link.frames;
  if (!sim.dropped) {
    onLine(JSON.stringify({ stat: { good: sim.good, bad_crc: sim.bad, missed: sim.missed } }));
  }
}, 1000);

/* =====================================================================
   Rendering
   ===================================================================== */

function drawDials() {
  for (const ch of DIAL_CHANNELS) {
    const svg = $('#gauge-' + ch.key);
    const pct = clamp((ch.value - ch.min) / (ch.max - ch.min), 0, 1);

    svg.querySelector('.fill').setAttribute('stroke-dasharray', `${pct * 100} 100`);
    svg.querySelector('.value').textContent = fmt(ch, ch.value);
    svg.setAttribute('class', 'gauge ' + statusOf(ch, ch.value));
  }

  for (const ch of BAR_CHANNELS) {
    const bar = $('#bar-' + ch.key);
    const pct = (v) => clamp((v - ch.min) / (ch.max - ch.min), 0, 1);
    const peak = ch.peak ?? ch.min;

    bar.querySelector('.bar-fill').style.transform = `scaleY(${pct(ch.value)})`;
    bar.querySelector('.bar-peak').style.bottom = `${pct(peak) * 100}%`;
    bar.querySelector('.bar-peak').style.opacity = peak > ch.min ? 1 : 0;
    bar.querySelector('.bar-value').textContent = fmt(ch, ch.value);
    bar.querySelector('.bar-peak-label').textContent = 'peak ' + fmt(ch, peak);
  }

  for (const ch of GEAR_CHANNELS) {
    const card = $('#gear-' + ch.key);
    const g = clamp(Math.round(ch.value), ch.min, ch.max);
    card.querySelector('.gear-value').textContent = gearLabel(g);
    [...card.querySelector('.gear-strip').children].forEach((cell, i) => {
      cell.className = i === g ? 'on' : '';
    });
  }

  for (const ch of FUEL_CHANNELS) {
    const card = $('#fuel-' + ch.key);
    const pct = clamp((ch.value - ch.min) / (ch.max - ch.min), 0, 1);
    card.classList.toggle('warn', statusOf(ch, ch.value) === 'warn');
    card.classList.toggle('bad', statusOf(ch, ch.value) === 'bad');
    card.querySelector('.fuel-value').firstChild.textContent = fmt(ch, ch.value);
    card.querySelector('.fuel-bar').style.setProperty('--p', pct);
  }

  for (const ch of TYRE_CHANNELS) {
    const ring = $('#ring-' + ch.key);
    const pct = clamp((ch.value - ch.min) / (ch.max - ch.min), 0, 1);
    ring.style.setProperty('--p', pct);
    ring.querySelector('.value').textContent = fmt(ch, ch.value);
    ring.className = 'ring ' + statusOf(ch, ch.value);
  }

  // Shift light: starts at 6500 rpm, one segment per 450 rpm.
  const lit = clamp(Math.round((CHANNELS[0].value - 6500) / 450), 0, 10);
  [...$('#shift-light').children].forEach((seg, i) => {
    seg.className = i >= lit ? '' : i < 5 ? 'on' : i < 8 ? 'hot' : 'max';
  });
}

function drawTraces() {
  const css = getComputedStyle(document.documentElement);
  const dpr = devicePixelRatio || 1;

  for (const ch of TRACE_CHANNELS) {
    const canvas = $('#trace-canvas-' + ch.key);
    const W = Math.round(canvas.clientWidth * dpr);
    const H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) continue;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const yOf = (v) => H - ((v - ch.min) / (ch.max - ch.min)) * H * 0.9 - H * 0.05;

    // Grid lines
    ctx.strokeStyle = css.getPropertyValue('--grid');
    ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(0, (H * k) / 4);
      ctx.lineTo(W, (H * k) / 4);
      ctx.stroke();
    }

    // Dashed alarm thresholds
    ctx.strokeStyle = css.getPropertyValue('--bad');
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    for (const limit of [ch.hi, ch.lo]) {
      if (limit == null) continue;
      ctx.beginPath();
      ctx.moveTo(0, yOf(limit));
      ctx.lineTo(W, yOf(limit));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Signal line, right-aligned so the newest sample is at the right edge.
    // Whatever is past a dashed alarm line is drawn red; the rest is green.
    const hist = ch.history;
    const status = statusOf(ch, ch.value);
    ctx.lineWidth = 2 * dpr;
    const linePath = new Path2D();
    hist.forEach((v, j) => {
      const x = W - ((hist.length - 1 - j) / (HISTORY_LENGTH - 1)) * W;
      j ? linePath.lineTo(x, yOf(v)) : linePath.moveTo(x, yOf(v));
    });

    // Bands of the canvas, top to bottom, with the colour the line takes inside each.
    const hiY = ch.hi != null ? yOf(ch.hi) : 0;
    const loY = ch.lo != null ? yOf(ch.lo) : H;
    const bands = [
      [0, hiY, '--bad'],              // above the high limit
      [hiY, loY, '--ok'],             // inside the limits
      [loY, H, '--bad'],              // below the low limit
    ];
    for (const [top, bottom, color] of bands) {
      if (bottom <= top) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, W, bottom - top);
      ctx.clip();
      ctx.strokeStyle = css.getPropertyValue(color);
      ctx.stroke(linePath);
      ctx.restore();
    }

    const label = $('#trace-value-' + ch.key);
    label.textContent = `${fmt(ch, ch.value)} ${ch.unit}`;
    label.style.color = status ? statusColor(status) : '';
  }
}

function drawStatusBar() {
  const age = performance.now() - link.lastFrameAt;
  const stale = age > STALE_AFTER_MS;

  $('#main').classList.toggle('stale', stale);
  $('#link-dot').style.background = stale ? 'var(--bad)' : 'var(--ok)';
  $('#link-label').textContent = stale ? 'No data' : 'Live';
  $('#frame-rate').textContent = `${link.rate} frames/s`;
  $('#error-count').textContent = `${link.crcErrors} CRC errors, ${link.missed} missed`;
  $('#data-age').textContent = `${Math.round(age)} ms old`;
}

setInterval(() => {
  drawStatusBar();
  drawDials();
  drawTraces();
}, 50);

/* =====================================================================
   Controls
   ===================================================================== */

$('#drop-link').onclick = () => {
  sim.dropped = !sim.dropped;
  $('#drop-link').textContent = sim.dropped ? 'Restore link' : 'Drop link';
};
