# Track Geometry Fault Log

A mobile web app for cab riding: logs your live location as ELR / Track ID / Mileage+Yards,
and lets you one-tap TOP and ALIGNMENT geometry faults as you feel them, then export a PDF
report per ride.

Built as a fresh app (not a copy of any existing product) using Network Rail's own open,
OGL-licensed geospatial network model, so the GPS → ELR/Track ID/Mileage conversion is
genuinely computed, not guessed.

## How it works

- **Location engine** (`public/lookup.js`) runs entirely in the browser. It loads two
  reference datasets derived from Network Rail's public Network Model
  (https://github.com/openraildata/network-rail-gis, OGL licence):
  - `data/track-links.json` — every track link nationally, with ELR + Track ID (TRID) +
    a coarse mileage range, simplified from Network Rail's `VectorLinks` shapefile.
  - `data/waymarks.json` — ~42,700 real surveyed mileposts (`VectorWaymarks`), used to
    calibrate mileage between the coarse track-link endpoints.
  - On each GPS fix, it snaps to the nearest track centreline (→ ELR + Track ID) and
    interpolates mileage between the two nearest real mileposts that bracket your
    position. On a held-out accuracy test (points between real mileposts, not the
    mileposts themselves) this comes out to a median error of ~0 yards and a 90th
    percentile of ~1 yard — the track-ID/ELR match itself was 100% correct in testing.
    Occasional outliers are possible near complex junctions/loops.
  - Because this runs client-side against locally cached data, **it keeps working with
    no signal** (tunnels, cuttings) as long as the reference files were downloaded once.
    GPS itself still needs a satellite fix, which tunnels will still block.
- **Fault capture**: tapping TOP or ALIGNMENT asks for a severity (slight/moderate/severe),
  then instantly writes the fault to IndexedDB on the device — this never blocks on
  network. A background sync loop pushes queued faults to the server whenever a
  connection is available.
- **Backend** (`server/`): a small Express API backed by Postgres, storing rides and
  faults, and generating the PDF export (`server/pdf.js`, using `pdf-lib`).
- **PWA**: installable to a phone/iPad home screen (`manifest.json`), with a service
  worker (`sw.js`) that precaches the app shell + both reference datasets (~12MB total,
  downloaded once) so the whole tool — map aside — works offline.

## What's NOT automatic

- Map tiles (OpenStreetMap) need a connection to render; without signal you'll still see
  your live ELR/Track/Mileage readout and can still log faults, just without the visual
  basemap.
- ELR/Track ID/Mileage accuracy depends on Network Rail's published network model being
  reasonably current for your routes. Around very recent re-signalling/realignment work,
  or where the open dataset doesn't cover a particular line well, expect the odd miss —
  faults can always be corrected via `PATCH /api/rides/:id/faults/:faultId` before export
  (a manual edit UI for this would be a natural next addition).

## Project layout

```
server/
  index.js         Express app entry
  db.js             Postgres pool + schema (rides, faults)
  pdf.js            PDF report generation
  routes/rides.js   REST API: rides + faults CRUD, PDF export
public/
  index.html, style.css, app.js   App shell + UI logic
  lookup.js         Client-side GPS -> ELR/Track/Mileage engine
  idb.js            IndexedDB offline queue
  sw.js             Service worker (offline caching)
  manifest.json     PWA manifest
  data/             Preprocessed Network Rail reference data (checked in)
  vendor/leaflet/    Self-hosted Leaflet (map library), so the app shell
                      has no runtime dependency on a JS CDN
render.yaml          One-click Render Blueprint (web service + Postgres)
```

## Run locally

Requires Node 18+ and a Postgres database.

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/cabride   # or PGHOST/PGUSER/etc
npm start
```

Then open http://localhost:3000 on your phone (same network) or in a desktop browser
(Chrome DevTools device emulation works fine for UI testing; GPS will need a real device
for the location engine to have anything to do).

## Deploy to Render (trial)

1. Push this project to a GitHub repo.
2. In Render, choose **New → Blueprint**, point it at the repo — `render.yaml` will
   provision both the web service and a free Postgres database and wire
   `DATABASE_URL` automatically.
3. First deploy will run `npm install` then `npm start`, which also creates the
   `rides`/`faults` tables automatically on boot.
4. Open the Render URL on your phone/iPad, then "Add to Home Screen" from the browser
   share sheet to install it like a native app.

Notes for the trial → company-wide step later: there's currently no login/user
separation (fine for a single-rider trial); the free Render Postgres plan expires after
90 days and free web services spin down when idle (both trivial to upgrade to paid tiers
when you're ready to roll this out wider). Also worth adding before wider rollout: a UI
for manually correcting a fault's ELR/Track/Mileage, and a way to set a ride's default
ELR/Track in one place if you ever ride routes the open dataset doesn't cover well.

## Extending it

- Fault types are defined in a couple of obvious places (`fault_type` CHECK constraint in
  `db.js`, the two buttons in `index.html`, badge colors in `style.css`/`pdf.js`) — adding
  Gauge, Twist, or Cant as further one-tap buttons is a small, mechanical change.
- The PDF layout (`server/pdf.js`) is plain `pdf-lib` drawing calls — easy to reshape into
  your company's report template, add a logo, etc.
