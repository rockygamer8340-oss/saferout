# SafeRoute Guardian (prototype)

**Online lagana hai? [SETUP.md](SETUP.md) padho (Hinglish, step by step).**

A phone and desktop web app (installable as a PWA) that watches a planned route and checks on the user when she leaves it.

## What it does

1. **Plan a route.** Tap the map to set start and destination (or use your location). A walking route is drawn.
2. **Leave the route → bot call.** When she is more than the set distance (default 150 m) off the route, the guardian bot rings. It asks “Are you safe?” by voice, and she can answer by voice, by button or (with the server) by pressing 1/2 on a real phone call.
3. **Safe → reason → marked place → face check.** She says why she chose this place. It is marked on the map. Then the camera checks her face against the enrolled face before the trip continues on a new route.
4. **Destination change** works the same way: bot call, reason, marked place, face check.
5. **3 missed calls** → alert with a map link to the nearest police station (looked up from OpenStreetMap, fallback number 112) and all family contacts.
6. **“I am not safe”** (or SOS button, or 3 failed face checks, or no reply for 60 s) → police and family are alerted. The camera opens full screen and cannot be closed until her face is recognised **and** she says (or types) “I am safe now”. Family get live location every 2 minutes during the emergency, and a “she is safe now” message when it ends. Reloading the page reopens the lock.

Face recognition runs fully on the phone with face-api.js. Only a 128-number face signature is stored, never a photo.

## Run it

```bash
node server/server.js          # app: http://localhost:8080  website: http://localhost:8080/site/
```

Needs Node 18+. No npm install. Without Twilio settings it runs in **dry-run** mode and only prints messages. Camera, microphone and GPS need HTTPS (or localhost).

## Making alerts real

| What | What you need |
|---|---|
| SMS to family and police | A [Twilio](https://www.twilio.com) account with an SMS-capable number. Indian numbers need DLT registration for SMS. |
| Real bot phone call | Same Twilio number with voice. The server must be on a public HTTPS address (`PUBLIC_URL`) so Twilio can reach its webhooks. |
| Police | Police stations do not accept SMS from apps in general. For real use, integrate with the official ERSS 112 system (via the state/central government) or agree a number with local police. Until then the app sends to the police number set in Setup. |

Start the server with:

```bash
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1... \
PUBLIC_URL=https://your-server.example.com APP_KEY=long-random-secret \
node server/server.js
```

Then in the app: **Setup → Sending real alerts → Real, through my SafeRoute server**, enter the server address and the same `APP_KEY`, and tick “Also ring my real phone” for real calls.

## Known limits of this prototype

- A web page cannot run in the background on a phone. When the browser is closed or the screen is locked for long, tracking stops. A real product needs a native app (Android/iOS) with background location.
- Face check has no liveness test, so a photo of her could fool it. Add a blink/turn-head check before real use.
- Voice recognition works in Chrome/Edge and Android; elsewhere she types “I am safe now”.
- Map tiles, routing and police lookup use free OpenStreetMap services (tile.openstreetmap.org, OSRM demo, Overpass). They are fine for testing but need your own or paid providers for many users.

## Files

- `site/index.html`: the website (one self-contained file, dark cinematic style, hero video). Its buttons open the app at `../index.html`, so host the whole folder together.
- `index.html`, `styles.css`, `app.js`: the app
- `vendor/`: Leaflet 1.9.4 and face-api 1.7.15 (MIT licences included)
- `models/`: face detection and recognition weights
- `server/server.js`: static server + Twilio SMS/call API
- `manifest.webmanifest`, `sw.js`, `icon.svg`: install to home screen, offline shell
