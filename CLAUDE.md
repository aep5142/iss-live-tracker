# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Assignment 4 for Design, Build, Ship (MPCS 51238, Spring 2026). Build and deploy a multi-service system that polls a live data source, stores it in a database, and displays real-time updates on a frontend.

**Required architecture:** External Data Source → Background Worker (Railway) → Database (Supabase + Realtime) → Frontend (Next.js on Vercel)

Due Week 5 (week of April 20, 2026).

## Topic: ISS Live Tracker

Polls the International Space Station's position and renders it on a 3D globe that updates in realtime.

**Data sources (free, no API key):**
- `https://api.wheretheiss.at/v1/satellites/25544` — ISS position. Returns `latitude`, `longitude`, `altitude` (km), `velocity` (km/h), `visibility` (`daylight` / `eclipsed` / `visible`), `footprint`, `timestamp`. Changes noticeably every few seconds (~27,600 km/h, ~90 min orbital period).
- `http://api.open-notify.org/astros.json` — current crew on all spacecraft (name + craft). Slow-changing; poll hourly.

**Why not NASA NeoWS / Mars Weather:** NeoWS refreshes only once per day (not meaningfully "realtime"). InSight Mars weather telemetry has been stale since ~2022. ISS is the best-fit data source for this assignment.

## UX

Primary view is **Option 1** (per hand-sketch in `/Users/agustin.ep/Downloads/IMG_2708.HEIC`): 3D Earth globe with the ISS orbiting around it. Option 2 (POV from the ISS with Earth rotating below) was considered but deferred — same data pipeline, ~2–3× the frontend work. Revisit as stretch.

**Features shipped — Globe:**
- Orbit trail — configurable window (30 / 60 / 90 min / 3 H / 6 H / 12 H / 24 H) via the right-side selector; each window has its own accent color, applied to both the path gradient and the trail dots
- Trail is drawn flat on the surface (`alt: 0`) — just the 2D path. Trail "dots" at each hover-anchor point are still in the scene but rendered with fully-transparent color so only the line is visible while hover-picking keeps working
- ISS marker is the only 3D element on the globe: bigger amber dot at `alt: 0.06`, plus a pulsing amber ring (`ringsData`, max radius 4°, repeat ~1.4s) that makes "now" unmistakable next to the trailing dots
- Path is split into separate segments whenever consecutive samples are >60s apart, so worker gaps don't draw long great-circle chords across the globe
- Hoverable trail dots — one every ~30s of flight; anchored tooltip `ISS WAS HERE · X MIN AGO` (also `23s AGO` / `1h 23m AGO`); position snapshots on hover entry (doesn't chase the cursor); 500ms debounce prevents flicker between dots
- Smooth interpolation — great-circle SLERP in a `requestAnimationFrame` loop so the ISS glides between known fixes instead of teleporting
- Initial camera centering — pans to the ISS on first load
- **Recenter button** — crosshair icon top-right, smooth 1s pan back to the current ISS position (for when the user rotates the globe and loses it)
- Starfield background — `three-globe`'s `night-sky.png` texture

**Features shipped — HUD (mission-control aesthetic, "direction A"):**
- Geist Mono everywhere, uppercase tracked labels, amber (`#ffbf47`) + cyan (`#5dd8f7`) accents
- Bordered panels with `backdrop-blur-sm` and a soft amber glow shadow
- Layout: title **INTERNATIONAL SPACE STATION LIVE TRACKER** (large, cyan) top-center on `xl+` / top-left on narrower screens; `◉ TRACKING` status top-right; recenter crosshair to its right; telemetry panel vertically centered on the left; trail selector vertically centered on the right (both `w-64 h-[420px] p-5 text-[12px]` so they match); data source link `DATA SOURCE · wheretheiss.at ↗` bottom-left (external link)
- Telemetry rows: `LATITUDE`, `LONGITUDE`, `ALTITUDE` (1 decimal), `VELOCITY` (1 decimal), `SUNLIGHT` (color-coded: amber `SUNLIT` / cyan `VISIBLE` / red `ECLIPSED`), `OVER` (country or ocean). Rows are distributed with `flex justify-between` so they fill the panel height evenly
- Trail selector: 7 buttons, each row = colored swatch + label; active button gets that color as border + tinted background + text
- **Crew panel removed** — the user didn't want it, replaced by the trail selector. The `iss_crew` table and worker poll are still live but unused by the frontend

**Features shipped — Data plumbing:**
- Initial load + window-change calls RPC `iss_positions_window(minutes_back, target_points)` (see DB section) — returns ~1000 uniformly-sampled points regardless of window, bypassing Supabase's default 1000-row cap
- Realtime INSERTs append to the active window (deduped by `id`), trimmed to `MAX_TRAIL_POINTS = 2000`. Window lives in a ref so the subscription closure always sees the current value without resubscribing
- OVER-line reverse geocoding via `bigdatacloud` with in-memory cache; parentheticals (e.g. `(the)`) stripped from ISO-style country names; falls back to one of 5 ocean basins (`src/lib/oceans.ts`) when no country is returned
- Tab-away freeze + "YOU LOOKED AWAY FOR X s · ISS TRAVELED Y KM" toast via the Page Visibility API — marker halts when hidden, toast appears on return computed from last-known velocity × elapsed seconds

**Pending:**
- Vercel deploy (final assignment step)

**Deferred / dropped:**
- Day/night terminator shading on the globe (nice-to-have)
- ISS marker upgrade (3D model or sprite instead of a colored dot)
- Previously-planned multi-section layout (`SectionNav` / `CamerasSection` / `CrewSection`) — dropped: user explicitly declined the crew feature, and the globe + trail selector stands alone

## Setup

- Python 3.13 (managed via `asteroids/worker/.python-version`)
- `uv` for dependency management (`asteroids/worker/pyproject.toml`, no `requirements.txt`)
- All project code lives in `asteroids/` (worker, frontend, shared config). Name is a legacy holdover from an earlier plan — kept as the single project root rather than renaming.
- Orphan: `asteroids/worker/hello.py` (leftover from initial scaffold; safe to delete).

**Run the worker locally:**
```
cd asteroids/worker
uv sync
uv run main.py   # needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in asteroids/worker/.env (gitignored)
```

**Run the frontend locally:**
```
cd asteroids/frontend
npm install
npm run dev      # reads NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY from .env.local (gitignored)
```

## Architecture

Three independently deployed services.

### 1. Worker — Python on Railway
Polls `wheretheiss.at` (configured 5s sleep; effective ~13s insert cadence because the API frequently takes ~8s to respond — acceptable since the frontend interpolates). Inserts into `iss_positions`. Polls `/astros.json` hourly → upserts `iss_crew` then deletes rows not touched in the last 2 hours (keeps the table a live roster).

- Entry: `asteroids/worker/main.py`
- Deploy config: `asteroids/worker/railway.toml` (builder: Nixpacks, start: `uv run main.py`, restart: `ALWAYS`)
- Railway project + service: both named `iss-worker` (production environment)
- Env vars must be set **on the service directly** (not Railway "Shared Variables" — those don't auto-inject into services)

### 2. Database — Supabase
Project `iss-tracker`, ref `lqaasrrtsgdxtrzfcoux`, region us-east-2. Tables provisioned by migration `001_init_iss_schema`.

- `iss_positions` — time-series: `id`, `ts`, `inserted_at`, `lat`, `lon`, `altitude_km`, `velocity_kmh`, `visibility`. Index: `(ts desc)` for time-window queries.
- `iss_crew` — roster: `name`, `craft`, `updated_at`. Composite PK `(name, craft)`. Still populated by the worker but unused by the frontend (crew panel was removed).

**RPC — `iss_positions_window(minutes_back int, target_points int default 1000)`** — applied via migration `002_iss_positions_window_rpc`. Counts rows in the window, computes `stride = ceil(count / target_points)`, returns every strideth row (newest always included, stride-aligned via `row_number() over (order by ts desc)`), ordered `ts asc`. Called by the frontend on initial load and every window change — this is the bypass for Supabase's default `max_rows = 1000` limit (without it, asking for 6 H silently returned the *oldest* 1000 rows in the window and the ISS appeared to "fly" from ~3 hours ago to now on first INSERT). The RPC lives in the database only — no SQL file is tracked in this repo; it was applied via the Supabase MCP.

Both tables have RLS enabled with a single `public read` policy for `anon, authenticated`. Both are added to the `supabase_realtime` publication — the worker writes with the **service-role key** (bypasses RLS), the frontend reads with the **publishable key**. The RPC has `execute` granted to `anon, authenticated` and runs as `SECURITY INVOKER` so RLS still applies.

### 3. Frontend — Next.js on Vercel
- Next.js **16** (App Router, TypeScript, Tailwind v4, React 19, `src/` dir) — `create-next-app` scaffold at `asteroids/frontend/`.
- 3D globe via `react-globe.gl` (wraps `three-globe`; simpler API for this scope than raw `react-three-fiber`). Earth/topology/night-sky textures served via `cdn.jsdelivr.net`.
- Single client component `src/components/IssViewer.tsx` holds state, the RPC-backed window fetch (refetches on window change), the `iss_positions` Realtime subscription, the SLERP tween loop, the Page Visibility listener, and the hover tooltip wiring.
- Shared helpers in `src/lib/`: `supabase.ts` (client + types), `geocode.ts` (reverse-geocode with in-memory cache), `oceans.ts` (lat/lon → ocean-name fallback).
- Supabase client uses the publishable key `sb_publishable_…`.
- **Not yet deployed to Vercel** — final remaining step for the assignment.

**No auth.** Public read-only data — publishable key + permissive read RLS is enough. No Clerk.

The worker and frontend share no code except the Supabase connection (URL + keys via env vars, each service has its own copy).

## Deployment

| Service  | Where                                    | Status           |
| -------- | ---------------------------------------- | ---------------- |
| Worker   | Railway (`iss-worker`, production)       | Live             |
| Database | Supabase (`iss-tracker` / `lqaasrrtsgdxtrzfcoux`) | Live             |
| Frontend | Vercel                                   | Pending deploy   |

## Supabase MCP

Supabase MCP server is configured in `.mcp.json` (project scope) at `https://mcp.supabase.com/mcp`. Use it to run SQL, inspect schema, and manage Realtime publications.
