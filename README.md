# ISS Live Tracker

ISS Live Tracker is a realtime web application that follows the International Space Station on a 3D globe. A background worker polls live orbital data, stores it in Supabase, and the frontend streams those updates into a mission-control-style interface that shows the ISS moving continuously around Earth.

Live site: https://iss-live-tracker-nine.vercel.app/

## Architecture

This project follows the required multi-service pipeline for the assignment:

`External APIs -> Railway Worker -> Supabase + Realtime -> Next.js Frontend`

### System flow

1. External APIs provide live ISS position data and crew data.
2. A Python worker running on Railway polls those APIs on a schedule.
3. The worker writes fresh records into Supabase.
4. Supabase Realtime pushes new inserts to the frontend.
5. A Next.js app on Vercel renders the ISS on a 3D globe and updates the trail and telemetry live.

### Services

- Frontend: Next.js 16, React 19, Tailwind v4, `react-globe.gl`
- Worker: Python 3.13 with `uv`
- Database: Supabase Postgres + Realtime
- Deployment: Vercel + Railway

## What The Project Is About

The project tracks the current position of the ISS and turns that data into a realtime visualization. Instead of showing only a single latitude and longitude reading, it builds a live historical trail, interpolates movement between fixes, and displays telemetry in a way that feels closer to a mission-control display than a static dashboard.

The ISS was chosen because it is one of the best fits for a realtime systems assignment: the position changes every few seconds, the orbit is visually interesting, and the data is available from free public APIs without authentication.

## Main Features

- Live 3D globe showing the current ISS position
- Selectable trail windows: 30 min, 60 min, 90 min, 3 h, 6 h, 12 h, and 24 h
- Smooth interpolation between recorded fixes so the ISS glides instead of teleporting
- Adaptive trail segmentation so long windows remain continuous while real polling gaps still break the path
- Hover tooltip on the orbit trail showing when the ISS was at a prior location
- Telemetry panel with latitude, longitude, altitude, velocity, sunlight status, and current country/ocean
- Recenter control to snap the camera back to the live ISS position
- Mission-control visual styling with a starfield background and realtime HUD panels

## Data Sources

- ISS position: `https://api.wheretheiss.at/v1/satellites/25544`
- Crew roster: `http://api.open-notify.org/astros.json`

The position API provides fast-changing orbital data including latitude, longitude, altitude, velocity, and visibility state. Crew data changes much more slowly, so it is polled on a longer interval.

## Database And Realtime Design

Supabase stores the time-series ISS positions and the crew roster. The frontend reads public data through the publishable key, while the Railway worker writes through the service-role key.

To support long history windows without hitting Supabase's default row limits, the frontend calls a database RPC named `iss_positions_window(minutes_back, target_points)`. That RPC downsamples the requested time window to a manageable number of evenly distributed points, which keeps 6-hour, 12-hour, and 24-hour trails usable in the globe UI.

New inserts are also streamed to the frontend through Supabase Realtime so the active trail updates without a page refresh.

## Local Development

### Worker

```bash
cd asteroids/worker
uv sync
uv run main.py
```

Required environment variables in `asteroids/worker/.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Frontend

```bash
cd asteroids/frontend
npm install
npm run dev
```

Required environment variables in `asteroids/frontend/.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## Project Status

- Worker: live on Railway
- Database: live on Supabase
- Frontend: live on Vercel at https://iss-live-tracker-nine.vercel.app/

## Repository Structure

- `asteroids/worker` - polling service that fetches ISS data and writes to Supabase
- `asteroids/frontend` - Next.js application that renders the globe and HUD
- `asteroids/frontend/src/components/IssViewer.tsx` - main client component for globe rendering, realtime updates, interpolation, and hover behavior

