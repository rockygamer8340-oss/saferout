# SafeRoute Guardian

**Walk home, never alone.** SafeRoute watches the route a girl plans. If she leaves it, a guardian bot calls to check she is safe. If she does not answer, or says she is not safe, it alerts the police and her family.

**Live:** https://saferout.onrender.com (website) · https://saferout.onrender.com/index.html (app)

> Prototype. It runs in **demo mode** by default: alerts show inside the app and nothing is really sent. Real SMS and calls need a Twilio account ([SETUP.md](SETUP.md), Hinglish, step by step).

---

## How it works

| When | What SafeRoute does |
|---|---|
| She plans a trip | She taps her start and destination on the map. A walking route is drawn. |
| She goes more than 150 m off the route | The guardian bot rings and asks by voice: “Are you safe?” |
| She says she is safe | The bot asks why she chose this place and marks it on the map. Then the camera checks her face before the trip continues. |
| She changes her destination | Same thing: bot call, reason, marked place, face check. |
| She misses 3 calls | The nearest police station and her family get an SMS with her location on a map. |
| She says “I am not safe”, or presses **SOS** | Police and family are alerted at once. The camera opens and **cannot be closed** until it recognises her face **and** she says “I am safe now”. |
| During an emergency | Family get her live location every 2 minutes, and a “she is safe now” message when it ends. |

Other safety rules: 3 failed face checks, or no reply for 60 seconds after picking up, also count as an emergency. Reloading the page does not close the emergency camera.

## Privacy

- Face recognition runs **on the phone** (face-api.js). The app keeps a list of 128 numbers that describe the face, never a photo.
- Routes, marked places and contacts stay in the phone's browser storage.
- Location leaves the phone only inside an alert.

## Features

- Map with route planning (Leaflet + OpenStreetMap, walking routes from OSRM)
- Leave-route and destination-change detection
- In-app guardian bot call with ringtone, vibration, voice questions and voice answers (English and Hindi words such as “bachao”, “madad”)
- Optional real phone call through Twilio (press 1 = safe, 2 = not safe)
- Face enrolment and face check (camera, or a selfie photo as a fallback)
- Emergency lock screen with face + “I am safe now” unlock
- Nearest police station lookup (OpenStreetMap), fallback number 112
- SOS button always on screen
- Simulated walk for demos and testing
- Installable on the home screen (PWA), dark design matching the website

## Project structure

```
site/index.html          Website (landing page)
index.html               App
styles.css, app.js       App style and logic
vendor/                  Leaflet 1.9.4, face-api 1.7.15 (MIT)
models/                  Face detection and recognition weights
server/server.js         Web server + Twilio SMS and call API (no npm packages)
render.yaml              Render blueprint
netlify.toml             Netlify demo hosting (no real alerts)
manifest.webmanifest, sw.js, icon.svg   Home-screen install and offline shell
SETUP.md                 Hosting and Twilio guide in Hinglish
```

## Run on your computer

Needs Node 18 or newer. No `npm install` needed.

```bash
npm start
# website: http://localhost:8080
# app:     http://localhost:8080/index.html
```

Camera, microphone and GPS need HTTPS or localhost.

## Hosting (Render)

This repo is deployed on Render as a **Web Service**:

- Build command: `npm install`
- Start command: `npm start`
- Every push to `main` redeploys it automatically.

Without Twilio settings the server runs in **dry-run** mode and only prints messages to the log.

## Turning on real SMS and calls

Add these in Render → your service → **Environment**:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | From the Twilio console (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | From the Twilio console |
| `TWILIO_FROM` | Your Twilio number, like `+15551234567` |
| `APP_KEY` | Any long secret password you make up. **Required** once Twilio is set, or the server will not start. |

Then in the app: **Setup → Sending real alerts → “Real, through my SafeRoute server”**, leave the server address blank, and paste the same `APP_KEY`.

Twilio trial accounts can only send to numbers you verify in Twilio. See [SETUP.md](SETUP.md) for the full steps.

## Known limits

- **Police:** police stations do not accept SMS from apps in general. Real police alerts need an agreement with local police or the **112 ERSS** system. Until then alerts go to the police number set in the app (default 112).
- **Background tracking:** a web app stops tracking when the phone stays locked for long. A native Android/iOS app is needed for that.
- **Face check** has no liveness test yet, so a photo could fool it.
- **Render free plan** sleeps after 15 minutes idle, so the first request can take up to a minute. Use a paid plan for real use.
- Voice answers work in Chrome/Edge and on Android. Elsewhere she can tap or type.
- Map tiles, routing and police lookup use free OpenStreetMap services, which are fine for testing but not for many users.

## Credits

Built with [Leaflet](https://leafletjs.com), [face-api.js](https://github.com/vladmandic/face-api), [OpenStreetMap](https://www.openstreetmap.org) and [Twilio](https://www.twilio.com).
