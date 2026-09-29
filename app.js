/* SafeRoute Guardian — prototype.
 * Everything runs in the browser. Real calls/SMS/police alerts go through the optional
 * server in /server (Twilio). In "Demo" mode nothing leaves the phone: alerts are shown
 * in the "Places & alerts" tab marked SIMULATED.
 */
(() => {
'use strict';

// ---------- storage ----------
const KEY = 'saferoute.v1';
const store = {
  load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } },
  save(data) { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode */ } },
};

const SAMPLE_ROUTE = [
  [28.6315, 77.2167], [28.6282, 77.2189], [28.6231, 77.2191], [28.6181, 77.2196],
  [28.6152, 77.2211], [28.6136, 77.2250], [28.6129, 77.2295],
];

const defaults = () => ({
  settings: {
    name: '', phone: '', police: '112',
    contacts: [{ name: 'Mother', phone: '+91 90000 00001' }, { name: 'Brother', phone: '+91 90000 00002' }],
    threshold: 150, ring: 12, gap: 4, tries: 3,
    mode: 'simulated', server: '', key: '', realCall: false,
  },
  face: null,              // { descriptor: number[128], at }
  trip: {
    start: { lat: SAMPLE_ROUTE[0][0], lng: SAMPLE_ROUTE[0][1], label: 'Connaught Place' },
    dest: { lat: 28.6129, lng: 77.2295, label: 'India Gate' },
    route: SAMPLE_ROUTE, sample: true, active: false,
  },
  places: [],              // marked places { lat, lng, reason, at, kind }
  outbox: [],              // alerts { to, name, body, at, status, kind }
  log: [],                 // { at, text, tone }
  emergency: null,         // { reason, at }
});

let S = Object.assign(defaults(), store.load() || {});
S.settings = Object.assign(defaults().settings, S.settings || {});
const save = () => store.save(S);

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
const fmtLL = (p) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
const mapsLink = (p) => `https://maps.google.com/?q=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(text, ms = 2600) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function log(text, tone = '') {
  S.log.unshift({ at: now(), text, tone }); S.log = S.log.slice(0, 200); save(); renderLog();
}
async function fetchTimeout(url, opts = {}, ms = 6000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// geo
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// distance from point to polyline, using a local flat projection (fine at city scale)
function distToRoute(p, route) {
  if (!route || route.length < 2) return 0;
  const k = Math.cos(rad(p.lat));
  const xy = (q) => [rad(q[1]) * k * R, rad(q[0]) * R];
  const [px, py] = xy([p.lat, p.lng]);
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, ay] = xy(route[i]), [bx, by] = xy(route[i + 1]);
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}
function routeLength(route) {
  let s = 0; for (let i = 1; i < route.length; i++) s += dist(ll(route[i - 1]), ll(route[i])); return s;
}
const ll = (a) => ({ lat: a[0], lng: a[1] });
// point at distance d along the route, plus unit normal (in degrees-ish) for side-stepping
function pointAlong(route, d) {
  let acc = 0;
  for (let i = 1; i < route.length; i++) {
    const a = ll(route[i - 1]), b = ll(route[i]), seg = dist(a, b);
    if (acc + seg >= d || i === route.length - 1) {
      const t = seg ? Math.min(1, (d - acc) / seg) : 0;
      const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      const k = Math.cos(rad(p.lat));
      let nx = -(b.lat - a.lat), ny = (b.lng - a.lng) * k; const n = Math.hypot(nx, ny) || 1;
      return { p, normal: { lat: ny / n, lng: nx / n / k } };
    }
    acc += seg;
  }
  return { p: ll(route[0]), normal: { lat: 0, lng: 0 } };
}
const metersToDeg = (m) => m / 111320;

// routing: OSRM walking route, falls back to a straight line
async function buildRoute(a, b) {
  try {
    const url = `https://router.project-osrm.org/route/v1/foot/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetchTimeout(url, {}, 6000);
    const j = await res.json();
    const coords = j.routes?.[0]?.geometry?.coordinates;
    if (coords?.length > 1) return coords.map(([x, y]) => [y, x]);
  } catch { /* offline or blocked */ }
  const n = Math.max(2, Math.ceil(dist(a, b) / 100));
  return Array.from({ length: n + 1 }, (_, i) => [a.lat + (b.lat - a.lat) * (i / n), a.lng + (b.lng - a.lng) * (i / n)]);
}
async function placeName(p) {
  try {
    const res = await fetchTimeout(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&lat=${p.lat}&lon=${p.lng}`, {}, 5000);
    const j = await res.json();
    if (j.display_name) return j.display_name.split(',').slice(0, 2).join(',').trim();
  } catch { /* ignore */ }
  return fmtLL(p);
}
async function nearestPolice(p) {
  try {
    const q = `[out:json][timeout:8];nwr(around:6000,${p.lat},${p.lng})[amenity=police];out center 15;`;
    const res = await fetchTimeout('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q), {}, 9000);
    const j = await res.json();
    const list = (j.elements || []).map((e) => {
      const q2 = { lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon };
      return { name: e.tags?.name || 'Police station', phone: e.tags?.phone || e.tags?.['contact:phone'] || '', at: q2, d: dist(p, q2) };
    }).filter((x) => x.at.lat).sort((x, y) => x.d - y.d);
    if (list.length) return list[0];
  } catch { /* ignore */ }
  return null;
}

// ---------- map ----------
let map, routeLine, startMk, destMk, posMk, placesLayer, pickMode = null;
function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView([28.622, 77.222], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  placesLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  drawTrip(true);
}
function drawTrip(fit) {
  const t = S.trip;
  if (routeLine) routeLine.remove();
  if (startMk) startMk.remove();
  if (destMk) destMk.remove();
  const css = getComputedStyle(document.documentElement);
  const routeColor = css.getPropertyValue('--route').trim() || '#2f5fd6';
  if (t.route?.length > 1) routeLine = L.polyline(t.route, { color: routeColor, weight: 6, opacity: .85 }).addTo(map);
  if (t.start) startMk = L.circleMarker([t.start.lat, t.start.lng], { radius: 9, color: routeColor, weight: 4, fillColor: '#fff', fillOpacity: 1 }).bindTooltip('Start').addTo(map);
  if (t.dest) destMk = L.circleMarker([t.dest.lat, t.dest.lng], { radius: 10, color: '#fff', weight: 3, fillColor: routeColor, fillOpacity: 1 }).bindTooltip('Destination').addTo(map);
  if (fit && routeLine) map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
  drawPlaces();
  renderTrip();
}
function drawPlaces() {
  placesLayer.clearLayers();
  const css = getComputedStyle(document.documentElement);
  for (const pl of S.places) {
    const color = pl.kind === 'emergency' ? css.getPropertyValue('--danger').trim() : css.getPropertyValue('--amber').trim();
    L.circleMarker([pl.lat, pl.lng], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
      .bindPopup(`<b>${esc(pl.kind === 'emergency' ? 'Emergency' : 'Marked place')}</b><br>${esc(pl.reason)}<br><small>${esc(fmtDate(pl.at))}</small>`)
      .addTo(placesLayer);
  }
}
function setPos(p, off) {
  if (!posMk) {
    posMk = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div class="pos-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map);
  }
  posMk.setLatLng([p.lat, p.lng]);
  posMk.getElement()?.firstElementChild?.classList.toggle('off', !!off);
}
function setHint(text) { const h = $('mapHint'); h.textContent = text || ''; h.hidden = !text; }

async function onMapClick(e) {
  if (!pickMode) return;
  const p = { lat: e.latlng.lat, lng: e.latlng.lng };
  const mode = pickMode; pickMode = null; setHint('');
  if (mode === 'newdest') { pendingNewDest?.(p); return; }
  S.trip.sample = false; $('demoNote').hidden = true;
  S.trip[mode] = { ...p, label: fmtLL(p) };
  if (S.trip.start && S.trip.dest) S.trip.route = await buildRoute(S.trip.start, S.trip.dest); else S.trip.route = [];
  save(); drawTrip(mode === 'dest');
  S.trip[mode].label = await placeName(p); save(); renderTrip();
}

// ---------- tracking ----------
const T = { pos: null, watchId: null, simTimer: null, simD: 0, simOff: 0, simDir: 0, simPaused: false, checking: false, lastOff: 0, emTimer: null };

function startTracking() {
  stopTracking();
  if ($('simMode').checked || !navigator.geolocation) {
    $('simBar').hidden = false;
    T.simD = 0; T.simOff = 0; T.simDir = 0; T.simPaused = false; $('simPause').textContent = 'Pause';
    T.simTimer = setInterval(simTick, 500);
    simTick();
  } else {
    T.watchId = navigator.geolocation.watchPosition(
      (g) => onPosition({ lat: g.coords.latitude, lng: g.coords.longitude }),
      (err) => { toast('Location is off. Switched to simulated walk.'); $('simMode').checked = true; startTracking(); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
}
function stopTracking() {
  if (T.watchId != null) navigator.geolocation.clearWatch(T.watchId);
  clearInterval(T.simTimer); T.watchId = null; T.simTimer = null; $('simBar').hidden = true;
}
function simTick() {
  if (T.simPaused || T.checking) return;
  const route = S.trip.route; const total = routeLength(route);
  T.simD = Math.min(total, T.simD + 14);
  T.simOff = Math.max(0, T.simOff + T.simDir * 28);
  const { p, normal } = pointAlong(route, T.simD);
  const q = { lat: p.lat + normal.lat * metersToDeg(T.simOff), lng: p.lng + normal.lng * metersToDeg(T.simOff) };
  onPosition(q);
}
function onPosition(p) {
  T.pos = p;
  const t = S.trip;
  const off = distToRoute(p, t.route);
  const lim = S.settings.threshold;
  setPos(p, off > lim);
  $('offBy').textContent = fmtM(off);
  $('allowed').textContent = fmtM(lim);
  $('toDest').textContent = t.dest ? fmtM(dist(p, t.dest)) : '–';
  const m = $('offMeter'); const pct = Math.min(100, (off / lim) * 100);
  m.style.width = pct + '%'; m.className = 'meter-fill' + (pct >= 100 ? ' over' : pct > 60 ? ' warn' : '');
  if (!t.active || S.emergency || T.checking) return;
  if (t.dest && dist(p, t.dest) < 40 && off <= lim) { arrive(); return; }
  const nearApproved = S.places.some((pl) => pl.tripId === t.id && dist(p, pl) < 120);
  if (off > lim && !nearApproved && Date.now() - T.lastOff > 5000) {
    runSafetyCheck({ why: `You are ${fmtM(off)} away from your planned route.`, kind: 'deviation' });
  }
}

async function startTrip() {
  unlockAudio();
  const t = S.trip;
  if (!t.start || !t.dest || !t.route?.length) { toast('Set a start and a destination first.'); return; }
  if (!S.face) toast('Tip: enroll your face in Setup so the bot can verify you.', 3600);
  t.active = true; t.id = Date.now(); save();
  log(`Trip started: ${t.start.label} → ${t.dest.label}`, 'safe');
  renderTrip(); startTracking();
}
function endTrip(msg) {
  S.trip.active = false; save(); stopTracking();
  log(msg || 'Trip ended', 'safe'); renderTrip();
}
function arrive() { endTrip(`Arrived at ${S.trip.dest.label}`); toast('You reached your destination. Trip ended.'); }

// ---------- safety check (bot call → safe? → reason → mark → face) ----------
let pendingNewDest = null;
async function runSafetyCheck({ why, kind, newDest }) {
  if (T.checking || S.emergency) return;
  T.checking = true; setPill();
  log(kind === 'destination' ? 'Destination change: bot calling' : `Left route: bot calling (${why})`, 'warn');
  try {
    const tries = +S.settings.tries || 3;
    let answered = null;
    for (let i = 1; i <= tries; i++) {
      answered = await botCall(i, tries, why);
      if (answered) break;
      log(`Bot call ${i} of ${tries} not answered`, 'warn');
      if (i < tries) await sleep((+S.settings.gap || 4) * 1000);
    }
    if (!answered) {
      closeCall();
      await emergency(`${S.settings.name || 'She'} did not answer ${tries} safety calls after ${kind === 'destination' ? 'changing destination' : 'leaving her route'}.`, 'no-answer');
      return;
    }
    const res = await conversation(answered, kind);
    closeCall();
    if (!res.safe) {
      await emergency(res.timeout ? 'She answered the safety call but stopped responding.' : 'She told the guardian bot she is NOT safe.', 'not-safe');
      return;
    }
    const here = newDest || T.pos;
    const place = { lat: here.lat, lng: here.lng, reason: res.reason, at: now(), kind: kind === 'destination' ? 'new destination' : 'detour', tripId: S.trip.id };
    S.places.unshift(place); save(); drawPlaces(); renderPlaces();
    log(`Marked place: “${res.reason}”`, 'safe');

    const ok = await faceVerify({ title: 'Face check', sub: 'The bot needs to see it is really you.', tries: 3, mandatory: true });
    if (ok === false) { await emergency('Face check failed 3 times after a route change.', 'face-failed'); return; }
    if (ok === 'skipped') log('Face check skipped: no face enrolled yet', 'warn');
    else log('Face verified', 'safe');

    // continue the trip from here
    if (newDest) S.trip.dest = { ...newDest, label: await placeName(newDest) };
    if (T.pos) {
      S.trip.route = await buildRoute(T.pos, S.trip.dest);
      T.simD = 0; T.simOff = 0; T.simDir = 0;
    }
    save(); drawTrip(false);
    toast('Thanks. Route updated. Stay safe.');
  } finally {
    T.checking = false; T.lastOff = Date.now(); setPill();
  }
}

// ---------- bot call UI ----------
let ring = null, audioCtx = null;
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
  try { speechSynthesis.getVoices(); } catch { /* ignore */ }
}
function startRing() {
  stopRing();
  navigator.vibrate?.([600, 400, 600, 400, 600, 400, 600]);
  if (!audioCtx) return;
  const beep = () => {
    for (const [f, t0] of [[880, 0], [660, .25], [880, .9], [660, 1.15]]) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine'; g.gain.value = 0.0001;
      o.connect(g); g.connect(audioCtx.destination);
      const s = audioCtx.currentTime + t0;
      g.gain.exponentialRampToValueAtTime(0.25, s + .02); g.gain.exponentialRampToValueAtTime(0.0001, s + .22);
      o.start(s); o.stop(s + .24);
    }
  };
  beep(); ring = setInterval(beep, 2400);
}
function stopRing() { clearInterval(ring); ring = null; navigator.vibrate?.(0); }

function botCall(attempt, tries, why) {
  return new Promise((resolve) => {
    const ov = $('callOverlay');
    ov.hidden = false; $('convo').hidden = true; $('convo').innerHTML = ''; $('answerArea').hidden = true; $('answerArea').innerHTML = '';
    $('ringActions').hidden = false;
    $('callReason').textContent = why;
    let left = +S.settings.ring || 12;
    const sub = () => ($('callSub').textContent = `Incoming call · attempt ${attempt} of ${tries} · ${left}s`);
    sub(); startRing();
    let phone = null;
    if (S.settings.mode === 'server' && S.settings.realCall && S.settings.phone) phone = server.call(S.settings.phone, attempt);

    const done = (v) => { clearInterval(tick); stopRing(); $('acceptCall').onclick = $('declineCall').onclick = null; if (phone) phone.stopWaitAnswer(); resolve(v); };
    const tick = setInterval(() => { left--; sub(); if (left <= 0) done(null); }, 1000);
    $('acceptCall').onclick = () => done({ via: 'app' });
    $('declineCall').onclick = () => done(null);
    if (phone) phone.waitAnswer().then((r) => r && done({ via: 'phone', phone }));
  });
}
function closeCall() { stopRing(); try { speechSynthesis.cancel(); } catch { /* */ } stopListening(); $('callOverlay').hidden = true; }

function bubble(text, who) {
  const b = document.createElement('div'); b.className = 'bubble ' + who; b.textContent = text;
  $('convo').appendChild(b); $('convo').scrollTop = 1e9;
}
function say(text) {
  bubble(text, 'bot');
  return new Promise((res) => {
    try {
      const u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; u.rate = 1;
      u.onend = res; u.onerror = res; speechSynthesis.cancel(); speechSynthesis.speak(u);
      setTimeout(res, Math.min(9000, 600 + text.length * 70));
    } catch { setTimeout(res, 800); }
  });
}

// speech recognition (Chrome/Edge/Android; not in every browser)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen(onText, { continuous = false, onFail } = {}) {
  if (!SR) return false;
  stopListening();
  try {
    rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = false; rec.continuous = continuous; rec.maxAlternatives = 3;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const alts = Array.from(e.results[i]).map((a) => a.transcript.toLowerCase().trim());
        onText(alts);
      }
    };
    rec.onerror = (e) => {
      // microphone blocked or speech service unreachable: stop and let the caller show a fallback
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(e.error)) { if (rec) rec._keep = false; onFail?.(e.error); }
    };
    rec.onend = () => { if (rec && rec._keep) { try { rec.start(); } catch { /* */ } } };
    rec._keep = true; rec.start();
    return true;
  } catch { rec = null; return false; }
}
function stopListening() { if (rec) { rec._keep = false; try { rec.stop(); } catch { /* */ } rec = null; } }

const UNSAFE_WORDS = ['not safe', 'unsafe', 'help', 'danger', 'bachao', 'madad', 'no'];
const SAFE_WORDS = ['safe', 'fine', 'okay', 'ok', 'yes', 'theek', 'surakshit'];
function classify(alts) {
  for (const a of alts) {
    if (UNSAFE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(a))) return 'unsafe';
    if (SAFE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(a))) return 'safe';
  }
  return null;
}

async function conversation(answered, kind) {
  $('ringActions').hidden = true; $('convo').hidden = false;
  $('callSub').textContent = 'Connected';
  const name = S.settings.name ? ` ${S.settings.name}` : '';
  const q = kind === 'destination'
    ? `Hello${name}, this is your SafeRoute guardian. You are changing your destination. Are you safe?`
    : `Hello${name}, this is your SafeRoute guardian. You have left your planned route. Are you safe?`;
  await say(q);

  const answer = await new Promise((resolve) => {
    const area = $('answerArea'); area.hidden = false;
    area.innerHTML = `<div class="row"><button class="btn safe" data-v="safe" type="button">I am safe</button><button class="btn danger" data-v="unsafe" type="button">I am not safe</button></div><div class="listening" id="lst"></div>`;
    let finished = false;
    const fin = (v, heard) => { if (finished) return; finished = true; clearTimeout(to); stopListening(); if (heard) bubble(heard, 'me'); resolve(v); };
    area.querySelectorAll('button').forEach((b) => (b.onclick = () => fin(b.dataset.v, b.textContent)));
    if (answered.via === 'phone') answered.phone.waitDigits().then((d) => d && fin(d, d === 'safe' ? 'Pressed 1: safe' : 'Pressed 2: not safe'));
    const heard = listen((alts) => { const c = classify(alts); if (c) fin(c, alts[0]); }, { onFail: () => ($('lst').textContent = 'Tap your answer') });
    $('lst').textContent = heard ? 'Listening… say “I am safe” or “I am not safe”' : 'Tap your answer';
    const to = setTimeout(() => fin('timeout'), 60000);
  });
  if (answer === 'timeout') return { safe: false, timeout: true };
  if (answer === 'unsafe') { await say('Stay calm. I am alerting the police and your family now.'); return { safe: false }; }

  await say(kind === 'destination' ? 'Okay. Why did you choose this new destination?' : 'Okay. Why did you choose this location?');
  const reason = await new Promise((resolve) => {
    const area = $('answerArea');
    const picks = ['Meeting a friend', 'Shopping', 'Road was blocked', 'Took another bus'];
    area.innerHTML = `<div class="row">${picks.map((p) => `<button class="btn sm" data-p="${esc(p)}" type="button">${esc(p)}</button>`).join('')}</div>
      <div class="type-phrase"><input id="reasonIn" type="text" placeholder="Or type your reason" aria-label="Reason"><button class="btn sm" id="reasonGo" type="button">Send</button></div><div class="listening" id="lst"></div>`;
    let finished = false;
    const fin = (v) => { if (finished || !v) return; finished = true; stopListening(); bubble(v, 'me'); resolve(v); };
    area.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => fin(b.dataset.p)));
    $('reasonGo').onclick = () => fin($('reasonIn').value.trim());
    $('reasonIn').onkeydown = (e) => { if (e.key === 'Enter') fin($('reasonIn').value.trim()); };
    const heard = listen((alts) => { if (alts[0]?.length > 2) fin(alts[0].replace(/^./, (c) => c.toUpperCase())); }, { onFail: () => ($('lst').textContent = '') });
    $('lst').textContent = heard ? 'Listening… or tap / type' : '';
  });
  $('answerArea').innerHTML = '';
  await say('Thank you. I have marked this place on your map. Now I will check your face.');
  return { safe: true, reason };
}

// ---------- face recognition (face-api.js, runs on-device) ----------
let faceReady = null;
function loadFace() {
  if (faceReady) return faceReady;
  faceReady = (async () => {
    if (!window.faceapi) {
      await new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = 'vendor/face-api.js'; s.onload = res; s.onerror = () => rej(new Error('face-api failed to load'));
        document.head.appendChild(s);
      });
    }
    // WebGL is fastest; plain CPU works everywhere (the WASM backend would need extra files)
    const tf = faceapi.tf;
    if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu');
    await tf.ready();
    await faceapi.nets.tinyFaceDetector.loadFromUri('models');
    await faceapi.nets.faceLandmark68TinyNet.loadFromUri('models');
    await faceapi.nets.faceRecognitionNet.loadFromUri('models');
    return true;
  })();
  faceReady.catch(() => (faceReady = null));
  return faceReady;
}
async function describe(input) {
  const r = await faceapi.detectSingleFace(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 }))
    .withFaceLandmarks(true).withFaceDescriptor();
  return r ? Array.from(r.descriptor) : null;
}
const MATCH = 0.5; // euclidean distance; lower = stricter
function matches(desc) {
  if (!S.face) return { ok: true, d: 0 };
  const d = faceapi.euclideanDistance(desc, S.face.descriptor);
  return { ok: d < MATCH, d };
}
async function openCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
    video.srcObject = stream; await video.play(); return stream;
  } catch { return null; }
}
const closeCamera = (stream) => stream?.getTracks().forEach((t) => t.stop());
function imgFromFile(file) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}

// mode: verify (returns true / false / 'skipped' / 'cancel') or enroll (returns descriptor or null)
async function faceVerify({ title, sub, tries = 3, mandatory = false, enroll = false }) {
  if (!enroll && !S.face) return 'skipped';
  const ov = $('faceOverlay'), video = $('faceVideo'), photo = $('facePhoto'), ringEl = $('faceRing'), msg = $('faceMsg');
  ov.hidden = false; $('faceTitle').textContent = title; $('faceSub').textContent = sub;
  $('faceCancel').hidden = mandatory; ringEl.className = 'cam-ring'; photo.hidden = true; video.hidden = false;
  msg.textContent = 'Loading face models…';
  try { await loadFace(); } catch { msg.textContent = 'Could not load face models.'; await sleep(1500); ov.hidden = true; return enroll ? null : 'skipped'; }

  let stream = await openCamera(video);
  let cancelled = false, failures = 0;
  const samples = [];
  const result = await new Promise((resolve) => {
    $('faceCancel').onclick = () => { cancelled = true; resolve(enroll ? null : 'cancel'); };
    const handle = (desc) => {
      if (!desc) { msg.textContent = 'No face found. Face the camera in good light.'; ringEl.className = 'cam-ring bad'; return 'none'; }
      if (enroll) {
        samples.push(desc);
        msg.textContent = `Face captured (${samples.length}/${stream ? 3 : 1})`; ringEl.className = 'cam-ring ok';
        if (samples.length >= (stream ? 3 : 1)) {
          const avg = samples[0].map((_, i) => samples.reduce((s, d) => s + d[i], 0) / samples.length);
          resolve(avg);
        }
        return 'ok';
      }
      const m = matches(desc);
      if (m.ok) { msg.textContent = 'Face verified. Thank you.'; ringEl.className = 'cam-ring ok'; setTimeout(() => resolve(true), 800); return 'ok'; }
      failures++; ringEl.className = 'cam-ring bad';
      msg.textContent = `This does not look like you (try ${failures} of ${tries}).`;
      if (failures >= tries) setTimeout(() => resolve(false), 900);
      return 'bad';
    };
    if (stream) {
      msg.textContent = enroll ? 'Hold still. Capturing your face…' : 'Checking your face…';
      $('facePhotoBtn').hidden = true;
      const loop = async () => {
        if (cancelled || ov.hidden) return;
        const desc = await describe(video).catch(() => null);
        const r = handle(desc);
        if (r === 'ok' && !enroll) return;
        if (r === 'ok' && enroll && samples.length >= 3) return;
        if (r === 'bad') { if (failures >= tries) return; await sleep(1500); }
        else await sleep(enroll ? 700 : 500);
        loop();
      };
      loop();
    } else {
      msg.textContent = 'Camera is not available here. Take a selfie instead.';
      video.hidden = true; $('facePhotoBtn').hidden = false;
      $('facePhotoInput').value = '';
      $('facePhotoInput').onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const img = await imgFromFile(f); photo.src = img.src; photo.hidden = false;
        msg.textContent = 'Checking…';
        const desc = await describe(img).catch(() => null);
        handle(desc); e.target.value = '';
      };
    }
  });
  closeCamera(stream); video.srcObject = null; ov.hidden = true; $('facePhotoBtn').hidden = true;
  return result;
}

// ---------- emergency ----------
async function emergency(why, code) {
  if (S.emergency) return;
  const p = T.pos || S.trip.start || { lat: 0, lng: 0 };
  S.emergency = { why, code, at: now(), lat: p.lat, lng: p.lng }; save();
  S.places.unshift({ lat: p.lat, lng: p.lng, reason: why, at: now(), kind: 'emergency', tripId: S.trip.id });
  save(); drawPlaces(); renderPlaces(); setPill();
  log('EMERGENCY: ' + why, 'danger');
  openLock();
  await sendEmergencyAlerts(why, p);
  // keep family updated with live location while the emergency lasts
  clearInterval(T.emTimer);
  T.emTimer = setInterval(() => {
    const q = T.pos || p;
    const body = `SafeRoute live location for ${S.settings.name || 'your family member'}: ${mapsLink(q)} (${fmtTime(now())})`;
    S.settings.contacts.filter((c) => c.phone).forEach((c) => notify({ to: c.phone, name: c.name, body, kind: 'family-update' }));
  }, 120000);
}

async function sendEmergencyAlerts(why, p) {
  const who = S.settings.name || 'A SafeRoute user';
  const phone = S.settings.phone ? ` Her phone: ${S.settings.phone}.` : '';
  const police = await nearestPolice(p);
  const policeTo = police?.phone || S.settings.police || '112';
  const policeName = police ? `${police.name} (${fmtM(police.d)} away)` : 'Police control room';
  const body = `SAFEROUTE EMERGENCY: ${who} may be in danger. ${why} Last location: ${mapsLink(p)} at ${fmtTime(now())}.${phone}`;
  notify({ to: policeTo, name: policeName, body, kind: 'police' });
  S.settings.contacts.filter((c) => c.phone).forEach((c) => notify({ to: c.phone, name: c.name, body: body + ` Nearest police: ${policeName}.`, kind: 'family' }));
}

let lockState = null;
function openLock() {
  const ov = $('sosOverlay'); ov.hidden = false;
  $('sosWhy').textContent = S.emergency.why;
  lockState = { face: false, faceAt: 0, voice: false, stream: null, closed: false };
  ['reqFace', 'reqVoice'].forEach((id) => $(id).classList.remove('done'));
  $('reqFace').lastChild.textContent = S.face ? 'Your face is recognised' : 'A face is seen (no face enrolled yet)';
  try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* */ }
  window.addEventListener('beforeunload', blockUnload);
  runLock();
}
function blockUnload(e) { e.preventDefault(); e.returnValue = ''; }

async function runLock() {
  const st = lockState, video = $('sosVideo');
  const heard = listen((alts) => { if (alts.some((a) => /i\s*am\s*safe\s*now|i'm\s*safe\s*now|ab\s*main\s*surakshit\s*hoon/.test(a))) phraseOk(); }, { continuous: true });
  // typing is always offered too: speech recognition is missing or silent in some browsers
  $('typePhrase').hidden = false;
  $('phraseInput').placeholder = heard ? 'Say it, or type: I am safe now' : 'Type: I am safe now';
  const ok = await loadFace().then(() => true).catch(() => false);
  st.stream = await openCamera(video);
  $('sosPhotoBtn').hidden = !!st.stream;
  video.hidden = !st.stream;
  if (!ok) { $('reqFace').lastChild.textContent = 'Face models could not load'; }
  if (st.stream && ok) {
    const loop = async () => {
      if (st.closed) return;
      const desc = await describe(video).catch(() => null);
      setFace(desc);
      await sleep(900); loop();
    };
    loop();
  }
  $('sosPhotoInput').onchange = async (e) => {
    const f = e.target.files[0]; if (!f || !ok) return;
    const img = await imgFromFile(f); $('sosPhoto').src = img.src; $('sosPhoto').hidden = false;
    setFace(await describe(img).catch(() => null)); e.target.value = '';
  };
}
function setFace(desc) {
  const st = lockState; if (!st || st.closed) return;
  const good = desc && matches(desc).ok;
  $('sosRing').className = 'cam-ring' + (desc ? (good ? ' ok' : ' bad') : '');
  if (good) { st.face = true; st.faceAt = Date.now(); }
  else if (Date.now() - st.faceAt > 15000) st.face = false; // face must be recent
  $('reqFace').classList.toggle('done', st.face);
  tryUnlock();
}
function phraseOk() {
  if (!lockState || lockState.closed) return;
  lockState.voice = true; $('reqVoice').classList.add('done'); tryUnlock();
}
function tryUnlock() {
  const st = lockState;
  if (!st || st.closed || !st.face || !st.voice) return;
  st.closed = true;
  stopListening(); closeCamera(st.stream); $('sosVideo').srcObject = null; $('sosPhoto').hidden = true;
  $('sosOverlay').hidden = true;
  window.removeEventListener('beforeunload', blockUnload);
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* */ }
  clearInterval(T.emTimer);
  const p = T.pos || S.emergency;
  const body = `SafeRoute update: ${S.settings.name || 'She'} confirmed she is safe now (face verified, said “I am safe now”). Location: ${mapsLink(p)} at ${fmtTime(now())}.`;
  S.settings.contacts.filter((c) => c.phone).forEach((c) => notify({ to: c.phone, name: c.name, body, kind: 'family-safe' }));
  S.emergency = null; save(); setPill();
  log('Emergency closed: face recognised and “I am safe now” heard', 'safe');
  toast('Emergency closed. Your family has been told you are safe.', 4000);
  T.lastOff = Date.now();
  if (S.trip.active && T.pos) { buildRoute(T.pos, S.trip.dest).then((r) => { S.trip.route = r; T.simD = 0; T.simOff = 0; T.simDir = 0; save(); drawTrip(false); }); }
}
document.addEventListener('keydown', (e) => { if (S.emergency && e.key === 'Escape') e.preventDefault(); }, true);

// ---------- sending (demo or real server) ----------
const server = {
  // blank = the server that is hosting this app (the usual Render setup)
  base() { return (S.settings.server || (/^https?:$/.test(location.protocol) ? location.origin : '')).replace(/\/+$/, ''); },
  async post(path, body) {
    const res = await fetchTimeout(this.base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Key': S.settings.key || '' }, body: JSON.stringify(body) }, 10000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  },
  // real phone call through Twilio. The server asks "press 1 if safe, 2 if not".
  call(to, attempt) {
    let stop = false; let idP = this.post('/api/call', { to, attempt, name: S.settings.name }).then((j) => j.id).catch(() => null);
    const poll = async (want) => {
      const id = await idP; if (!id) return null;
      while (!stop) {
        try {
          const j = await (await fetchTimeout(this.base() + '/api/call/' + id)).json();
          if (want === 'answer' && ['in-progress', 'completed'].includes(j.status)) return true;
          if (want === 'digits' && j.answer) return j.answer;
          if (['no-answer', 'busy', 'failed', 'canceled'].includes(j.status)) return null;
        } catch { /* keep polling */ }
        await sleep(2000);
      }
      return null;
    };
    return { waitAnswer: () => poll('answer'), waitDigits: () => { stop = false; return poll('digits'); }, stopWaitAnswer: () => { stop = true; } };
  },
};

async function notify({ to, name, body, kind }) {
  const item = { to, name, body, kind, at: now(), status: 'simulated' };
  S.outbox.unshift(item); save(); renderOutbox();
  if (S.settings.mode === 'server' && server.base()) {
    try { await server.post('/api/sms', { to, body }); item.status = 'sent'; }
    catch (e) { item.status = 'failed'; log(`Could not send to ${name}: ${e.message}`, 'danger'); }
    save(); renderOutbox();
  }
  $('sosSent').insertAdjacentHTML('afterbegin', `<li>${item.status === 'simulated' ? 'Demo, not sent' : esc(item.status)}: ${esc(name)} · ${esc(to)}</li>`);
}

// ---------- rendering ----------
function setPill() {
  const p = $('statusPill');
  if (S.emergency) { p.dataset.tone = 'emergency'; p.textContent = 'Emergency'; }
  else if (T.checking) { p.dataset.tone = 'check'; p.textContent = 'Safety check'; }
  else if (S.trip.active) { p.dataset.tone = 'active'; p.textContent = 'Trip active'; }
  else { p.dataset.tone = 'idle'; p.textContent = 'No trip'; }
}
function renderTrip() {
  const t = S.trip;
  $('startText').textContent = t.start?.label || 'Not set';
  $('destText').textContent = t.dest?.label || 'Not set';
  $('routeMeta').textContent = t.route?.length > 1 ? `Route ${fmtM(routeLength(t.route))} · leave-route alarm at ${fmtM(S.settings.threshold)}` : '';
  $('demoNote').hidden = !t.sample;
  $('startTrip').disabled = t.active; $('endTrip').disabled = !t.active; $('changeDest').disabled = !t.active;
  $('pickStart').disabled = t.active; $('pickDest').disabled = t.active; $('useMyLoc').disabled = t.active;
  $('live').hidden = !t.active;
  setPill();
}
function renderPlaces() {
  const ul = $('placesList');
  ul.innerHTML = S.places.length ? S.places.map((p) => `<li><span class="chip ${p.kind === 'emergency' ? 'danger' : 'warn'}">${esc(p.kind)}</span><b>${esc(p.reason)}</b><div class="meta">${esc(fmtDate(p.at))} · ${esc(fmtLL(p))}</div></li>`).join('')
    : '<li class="empty">No places marked yet. When you leave your route and tell the bot why, the place shows up here.</li>';
}
function renderOutbox() {
  const ul = $('outboxList');
  $('outboxNote').hidden = S.settings.mode === 'server';
  ul.innerHTML = S.outbox.length ? S.outbox.slice(0, 40).map((m) => `<li><span class="chip ${m.status === 'sent' ? 'safe' : m.status === 'failed' ? 'danger' : ''}">${m.status === 'simulated' ? 'demo · not sent' : esc(m.status)}</span><b>${esc(m.name)}</b> <span class="meta">${esc(m.to)} · ${esc(fmtTime(m.at))}</span><div class="msg-body">${esc(m.body)}</div></li>`).join('')
    : '<li class="empty">No alerts yet. Police and family messages appear here.</li>';
}
function renderLog() {
  const ul = $('logList');
  ul.innerHTML = S.log.length ? S.log.slice(0, 60).map((l) => `<li><span class="meta">${esc(fmtTime(l.at))}</span> ${l.tone ? `<span class="chip ${l.tone}">${l.tone === 'safe' ? 'ok' : l.tone === 'warn' ? 'check' : 'alert'}</span>` : ''}${esc(l.text)}</li>`).join('')
    : '<li class="empty">Nothing yet.</li>';
}
function renderSetup() {
  const s = S.settings;
  $('fName').value = s.name; $('fPhone').value = s.phone; $('fPolice').value = s.police;
  $('fThreshold').value = s.threshold; $('fRing').value = s.ring; $('fGap').value = s.gap; $('fTries').value = s.tries;
  $('fMode').value = s.mode; $('fServer').value = s.server; $('fKey').value = s.key; $('fRealCall').checked = s.realCall;
  const box = $('contacts');
  box.innerHTML = s.contacts.map((c, i) => `<div class="contact">
    <label class="field"><span>Name</span><input id="cName${i}" type="text" value="${esc(c.name)}"></label>
    <label class="field"><span>Phone</span><input id="cPhone${i}" type="tel" value="${esc(c.phone)}"></label>
    <button class="btn ghost sm" type="button" data-rm="${i}" aria-label="Remove ${esc(c.name)}">Remove</button></div>`).join('');
  box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { readContacts(); s.contacts.splice(+b.dataset.rm, 1); renderSetup(); }));
  const fs = $('faceStatus');
  fs.textContent = S.face ? `Face enrolled on ${fmtDate(S.face.at)}` : 'Not enrolled. The bot cannot check it is you until you do this.';
  fs.classList.toggle('ok', !!S.face);
}
function readContacts() {
  S.settings.contacts = S.settings.contacts.map((_, i) => ({ name: $('cName' + i)?.value.trim() || '', phone: $('cPhone' + i)?.value.trim() || '' }));
}

// ---------- wiring ----------
function bind() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.dataset.view !== tab.dataset.tab));
    try { localStorage.setItem(KEY + '.tab', tab.dataset.tab); } catch { /* */ }
  }));
  $('pickStart').onclick = () => { pickMode = 'start'; setHint('Tap the map to set your start'); };
  $('pickDest').onclick = () => { pickMode = 'dest'; setHint('Tap the map to set your destination'); };
  $('useMyLoc').onclick = () => {
    if (!navigator.geolocation) { toast('Location is not available on this device.'); return; }
    navigator.geolocation.getCurrentPosition(async (g) => {
      const p = { lat: g.coords.latitude, lng: g.coords.longitude };
      S.trip.sample = false; S.trip.start = { ...p, label: 'My location' };
      if (S.trip.dest) S.trip.route = await buildRoute(S.trip.start, S.trip.dest);
      save(); map.setView([p.lat, p.lng], 16); drawTrip(false);
      S.trip.start.label = await placeName(p); save(); renderTrip();
    }, () => toast('Location permission was refused. Tap the map instead.'), { enableHighAccuracy: true, timeout: 15000 });
  };
  $('startTrip').onclick = startTrip;
  $('endTrip').onclick = () => endTrip();
  $('changeDest').onclick = () => {
    unlockAudio();
    pickMode = 'newdest'; setHint('Tap the map to choose your new destination');
    pendingNewDest = (p) => { pendingNewDest = null; runSafetyCheck({ why: 'You are changing your destination.', kind: 'destination', newDest: p }); };
  };
  $('simPause').onclick = () => { T.simPaused = !T.simPaused; $('simPause').textContent = T.simPaused ? 'Resume' : 'Pause'; };
  $('simOff').onclick = () => { T.simDir = 1; T.simPaused = false; $('simPause').textContent = 'Pause'; };
  $('simBack').onclick = () => { T.simDir = -1; };
  $('sosBtn').onclick = () => { unlockAudio(); if (!S.emergency) emergency('She pressed the SOS button.', 'sos'); };
  $('phraseBtn').onclick = () => { if (/i\s*am\s*safe\s*now/i.test($('phraseInput').value)) { phraseOk(); $('phraseInput').value = ''; } else toast('Type exactly: I am safe now'); };
  $('clearLog').onclick = () => { S.log = []; S.outbox = []; S.places = []; save(); renderLog(); renderOutbox(); renderPlaces(); drawPlaces(); };
  $('addContact').onclick = () => { readContacts(); S.settings.contacts.push({ name: '', phone: '' }); renderSetup(); };
  $('setupForm').onsubmit = (e) => {
    e.preventDefault(); readContacts();
    const s = S.settings, n = (id, d) => (Number.isFinite(+$(id).value) && $(id).value !== '' ? +$(id).value : d);
    s.name = $('fName').value.trim(); s.phone = $('fPhone').value.trim(); s.police = $('fPolice').value.trim() || '112';
    s.threshold = n('fThreshold', 150); s.ring = n('fRing', 12); s.gap = n('fGap', 4); s.tries = n('fTries', 3);
    s.mode = $('fMode').value; s.server = $('fServer').value.trim(); s.key = $('fKey').value; s.realCall = $('fRealCall').checked;
    save(); renderTrip(); renderOutbox(); $('savedMsg').textContent = 'Saved';
    setTimeout(() => ($('savedMsg').textContent = ''), 2000);
  };
  $('enrollFace').onclick = async () => {
    const d = await faceVerify({ title: 'Enroll your face', sub: 'Look straight at the camera in good light.', enroll: true });
    if (d) { S.face = { descriptor: d, at: now() }; save(); renderSetup(); log('Face enrolled', 'safe'); toast('Face enrolled.'); }
  };
  $('enrollPhoto').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    toast('Reading your photo…');
    try {
      await loadFace(); const d = await describe(await imgFromFile(f));
      if (!d) { toast('No face found in that photo. Try a clear, front-facing selfie.'); return; }
      S.face = { descriptor: d, at: now() }; save(); renderSetup(); log('Face enrolled from photo', 'safe'); toast('Face enrolled.');
    } catch { toast('Could not load face models.'); }
  };
}

function boot() {
  bind(); initMap(); renderTrip(); renderPlaces(); renderOutbox(); renderLog(); renderSetup();
  try { const tab = localStorage.getItem(KEY + '.tab'); if (tab) document.querySelector(`.tab[data-tab="${tab}"]`)?.click(); } catch { /* */ }
  if (S.trip.active) { S.trip.active = false; save(); renderTrip(); } // trips don't survive a reload in this prototype
  if (S.emergency) { setPill(); openLock(); } // an emergency does survive a reload
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.SafeRoute = { S, T, emergency, runSafetyCheck, distToRoute }; // for debugging/testing
}
boot();
})();
