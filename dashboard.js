/* =====================================================================
   Setup
   ===================================================================== */

const $ = (selector) => document.querySelector(selector);

const HISTORY_LENGTH = 600;          // samples kept per channel for traces (30 s at 20 Hz)
const RAW_LINES_SHOWN = 8;
const MAX_RECORDED_LINES = 20000;
const STALE_AFTER_MS = 1000;

// 270° arc used by every gauge.
const GAUGE_ARC = 'M30.72 140A80 80 0 1 1 169.28 140';

// Display channels. `hi` / `lo` are alarm thresholds; `decimals` is display precision.
// `trace: true` shows the channel as a scrolling line chart instead of a dial.
const CHANNELS = [
  { key: 'rpm', name: 'Engine speed',  unit: 'rpm', min: 0,  max: 12000, hi: 10500, decimals: 0 },
  { key: 'spd', name: 'Vehicle speed', unit: 'mph', min: 0,  max: 80,               decimals: 0 },
  { key: 'thr', name: 'Throttle',      unit: '%',   min: 0,  max: 100,              decimals: 0 },
  { key: 'clt', name: 'Coolant temp',  unit: '°C',  min: 40, max: 130,   hi: 105,   decimals: 0, trace: true },
  { key: 'bat', name: 'Battery',       unit: 'V',   min: 10, max: 14.6,  lo: 11.5,  decimals: 1 },
  { key: 'oil', name: 'Oil pressure',  unit: 'psi', min: 0,  max: 90,    lo: 15,    decimals: 0 },
];

for (const ch of CHANNELS) {
  ch.value = 0;
  ch.history = [];
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
   Build the DOM: dials first, then full-width traces
   ===================================================================== */

const DIAL_CHANNELS = CHANNELS.filter((ch) => !ch.trace);
const TRACE_CHANNELS = CHANNELS.filter((ch) => ch.trace);

const dialCard = (ch, i) => `
  <div class="card${i < 2 ? ' big' : ''}">
    <h3>${ch.name}</h3>
    <svg class="gauge" id="gauge-${ch.key}" viewBox="0 0 200 170">
      <path class="track" pathLength="100" d="${GAUGE_ARC}"/>
      <path class="fill"  pathLength="100" d="${GAUGE_ARC}" stroke-dasharray="0 100"/>
      <text class="value" x="100" y="112">0</text>
      <text class="unit"  x="100" y="132">${ch.unit}</text>
      <text class="limit" x="36"  y="162">${ch.min}</text>
      <text class="limit" x="164" y="162">${ch.max}</text>
    </svg>
  </div>`;

const traceCard = (ch) => `
  <div class="card trace-card">
    <div class="trace-head">
      <h3>${ch.name} <span class="trace-span">· last ${HISTORY_LENGTH / 20} s</span></h3>
      <b id="trace-value-${ch.key}"></b>
    </div>
    <canvas id="trace-canvas-${ch.key}"></canvas>
  </div>`;

$('#gauge-grid').innerHTML =
  DIAL_CHANNELS.map(dialCard).join('') + TRACE_CHANNELS.map(traceCard).join('');

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
const recordedLines = [];

/** Store decoded values into channels. */
function feed(values) {
  for (const ch of CHANNELS) {
    const v = values[ch.key];
    if (v == null) continue;

    ch.value = v;
    ch.history.push(v);
    if (ch.history.length > HISTORY_LENGTH) ch.history.shift();
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
  rawLines.push(text);
  if (rawLines.length > RAW_LINES_SHOWN) rawLines.shift();
  recordedLines.push(text);
  if (recordedLines.length > MAX_RECORDED_LINES) recordedLines.shift();
  $('#raw-feed').textContent = rawLines.join('\n');

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

  sim.throttle = clamp(55 + 48 * Math.sin(t * 0.9) + 14 * Math.sin(t * 3.1), 0, 100);
  sim.speed += (8 + sim.throttle * 0.62 - sim.speed) * 0.04;

// these are what make the dials move in a realistic way, they will be removed when the real ESP32 is connected 

  const baseRpm = 1800 + sim.speed * 112;
  const rpm     = baseRpm + sim.throttle * 14 + Math.random() * 80;
  const coolant = 82 + Math.min(30, t * 0.03) + sim.throttle * 0.05 + Math.random() * 0.4;
  const battery = 13.6 - sim.throttle * 0.012 + Math.random() * 0.04;
  const oil     = 20 + baseRpm * 0.0055 + Math.random() * 1.5;

  emitFrame(0x100, [...u16le(rpm), ...u16le(sim.speed * 10), Math.round(sim.throttle)]);
  emitFrame(0x101, [...u16le((coolant + 40) * 10), ...u16le(battery * 1000), ...u16le(oil * 10)]);
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

    // Signal line, right-aligned so the newest sample is at the right edge
    const hist = ch.history;
    const status = statusOf(ch, ch.value);
    ctx.strokeStyle = css.getPropertyValue(status === 'bad' ? '--bad' : status === 'warn' ? '--warn' : '--ok');
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    hist.forEach((v, j) => {
      const x = W - ((hist.length - 1 - j) / (HISTORY_LENGTH - 1)) * W;
      j ? ctx.lineTo(x, yOf(v)) : ctx.moveTo(x, yOf(v));
    });
    ctx.stroke();

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

/* =====================================================================
   Downloads (only shown when the host provides a downloads capability)
   ===================================================================== */

(async () => {
  let downloads = null;
  try {
    downloads = window.claude ? await window.claude.use('downloads') : null;
  } catch {}

  if (!downloads) {
    $('.downloads').hidden = true;
    return;
  }

  const msg = $('#download-msg');
  const save = async (filename, data) => {
    try {
      await downloads.save({ filename, data });
      msg.textContent = 'Saved ' + filename;
    } catch (e) {
      msg.textContent = e?.code === 'declined' ? '' : 'Could not save: ' + (e?.message || 'unknown error');
    }
  };

  $('#download-channels').onclick = () =>
    save('channels.json', JSON.stringify(SIGNAL_MAP, null, 2) + '\n');

  $('#download-recording').onclick = () =>
    save('telemetry-fake.json', JSON.stringify(recordedLines.map((l) => JSON.parse(l)), null, 2) + '\n');
})();
