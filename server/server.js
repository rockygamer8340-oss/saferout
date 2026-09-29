// SafeRoute server: serves the app and sends real SMS / places real bot calls through Twilio.
// No npm packages needed (Node 18+).
//
//   TWILIO_ACCOUNT_SID=AC...  TWILIO_AUTH_TOKEN=...  TWILIO_FROM=+1...  \
//   PUBLIC_URL=https://your-server.example.com  APP_KEY=some-long-secret  node server/server.js
//
// Without the TWILIO_* variables it runs in dry-run mode: it prints every message instead of sending it.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const ROOT = path.resolve(__dirname, '..');
const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM: FROM, APP_KEY } = process.env;
// Render sets RENDER_EXTERNAL_URL by itself, so PUBLIC_URL is only needed on other hosts
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const LIVE = !!(SID && TOKEN && FROM);
if (LIVE && !APP_KEY) {
  // without a key anyone who finds the server could send SMS on your Twilio bill
  console.error('APP_KEY is required when Twilio is configured. Set APP_KEY to a long random secret.');
  process.exit(1);
}
const calls = new Map(); // id -> { status, answer }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream', '.png': 'image/png' };

async function twilio(pathname, params) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/${pathname}`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.message || 'Twilio error ' + res.status);
  return j;
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      try { resolve(ct.includes('json') ? JSON.parse(b || '{}') : Object.fromEntries(new URLSearchParams(b))); } catch { resolve({}); }
    });
  });
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-App-Key' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const authed = (req) => !APP_KEY || req.headers['x-app-key'] === APP_KEY;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    // --- app API ---
    if (p === '/api/sms' && req.method === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'bad app key' });
      const { to, body } = await readBody(req);
      if (!to || !body) return send(res, 400, { error: 'to and body are required' });
      if (!LIVE) { console.log(`[dry-run SMS] to ${to}: ${body}`); return send(res, 200, { ok: true, dryRun: true }); }
      const m = await twilio('Messages.json', { To: to, From: FROM, Body: body.slice(0, 1500) });
      return send(res, 200, { ok: true, sid: m.sid });
    }
    if (p === '/api/call' && req.method === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'bad app key' });
      const { to, name } = await readBody(req);
      if (!LIVE || !PUBLIC_URL) { console.log(`[dry-run CALL] to ${to}`); return send(res, 200, { id: null, dryRun: true }); }
      const c = await twilio('Calls.json', {
        To: to, From: FROM, Timeout: '25',
        Url: `${PUBLIC_URL}/twilio/voice?name=${encodeURIComponent(name || '')}`,
        StatusCallback: `${PUBLIC_URL}/twilio/status`, StatusCallbackEvent: 'initiated ringing answered completed',
      });
      calls.set(c.sid, { status: 'queued', answer: null });
      return send(res, 200, { id: c.sid });
    }
    const m = p.match(/^\/api\/call\/([\w-]+)$/);
    if (m) return send(res, 200, calls.get(m[1]) || { status: 'unknown' });

    // --- Twilio webhooks ---
    if (p === '/twilio/voice') {
      const name = url.searchParams.get('name');
      return send(res, 200, twiml(
        `<Gather numDigits="1" timeout="15" action="${xml(PUBLIC_URL)}/twilio/gather" input="dtmf speech" hints="safe, not safe, help">` +
        `<Say voice="Polly.Aditi">Hello ${xml(name || '')}. This is your SafeRoute guardian. You left your planned route. If you are safe, press 1 or say safe. If you are not safe, press 2 or say help.</Say>` +
        `</Gather><Say>No answer received. Alerting your contacts.</Say>`), 'text/xml');
    }
    if (p === '/twilio/gather') {
      const b = await readBody(req);
      const speech = (b.SpeechResult || '').toLowerCase();
      const unsafe = b.Digits === '2' || /not safe|help|danger|bachao/.test(speech);
      const safe = !unsafe && (b.Digits === '1' || /safe|fine|okay/.test(speech));
      const c = calls.get(b.CallSid); if (c) c.answer = unsafe ? 'unsafe' : safe ? 'safe' : 'unsafe';
      return send(res, 200, twiml(unsafe || !safe
        ? '<Say>Stay calm. Police and your family are being alerted now.</Say>'
        : '<Say>Thank you. Please open the SafeRoute app to tell us why you changed route, and verify your face.</Say>'), 'text/xml');
    }
    if (p === '/twilio/status') {
      const b = await readBody(req);
      const c = calls.get(b.CallSid); if (c) c.status = b.CallStatus;
      return send(res, 200, '');
    }

    // --- static files ---
    // "/" shows the website; the app lives at /index.html (the website's buttons link there)
    if (p === '/site') { res.writeHead(301, { Location: '/site/' }); return res.end(); }
    let rel = decodeURIComponent(p === '/' ? '/site/index.html' : p);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || file.includes(`${path.sep}server${path.sep}`) || /(^|[\/])\./.test(rel)) return send(res, 404, 'not found', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`SafeRoute on http://localhost:${PORT} (${LIVE ? 'LIVE Twilio' : 'dry-run, nothing is sent'})`));
