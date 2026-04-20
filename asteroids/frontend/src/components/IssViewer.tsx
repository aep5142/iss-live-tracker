"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { supabase, type IssPosition } from "@/lib/supabase";
import { reverseGeocode } from "@/lib/geocode";

const Globe = dynamic(() => import("react-globe.gl"), { ssr: false });

const WINDOWS = [
  { minutes: 30, color: "#ffbf47", label: "30 MIN" },
  { minutes: 60, color: "#5dd8f7", label: "60 MIN" },
  { minutes: 90, color: "#b485ff", label: "90 MIN" },
  { minutes: 180, color: "#7dff9e", label: "3 H" },
  { minutes: 360, color: "#ff8a5c", label: "6 H" },
  { minutes: 720, color: "#ff6ec7", label: "12 H" },
  { minutes: 1440, color: "#b9ff5c", label: "24 H" },
] as const;

const SAMPLED_TARGET_POINTS = 1000;
const MAX_TRAIL_POINTS = 2000;
const EXPECTED_POLL_MS = 13_000;
const HOVER_DOT_INTERVAL_S = 30;

function toVec3(lat: number, lon: number): [number, number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  return [
    Math.cos(phi) * Math.cos(lambda),
    Math.cos(phi) * Math.sin(lambda),
    Math.sin(phi),
  ];
}

function toLatLon(x: number, y: number, z: number) {
  const lat = (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI;
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  return { lat, lon };
}

function slerp(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  t: number,
) {
  const [x1, y1, z1] = toVec3(lat1, lon1);
  const [x2, y2, z2] = toVec3(lat2, lon2);
  const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return { lat: lat1, lon: lon1 };
  const sinO = Math.sin(omega);
  const a = Math.sin((1 - t) * omega) / sinO;
  const b = Math.sin(t * omega) / sinO;
  return toLatLon(a * x1 + b * x2, a * y1 + b * y2, a * z1 + b * z2);
}

type Tween = {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  startMs: number;
  durationMs: number;
};

type GlobeHandle = {
  pointOfView: (
    v: { lat: number; lng: number; altitude?: number },
    ms?: number,
  ) => void;
};

export default function IssViewer() {
  const [positions, setPositions] = useState<IssPosition[]>([]);
  const [windowMin, setWindowMin] = useState<number>(90);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [displayPos, setDisplayPos] = useState<{
    lat: number;
    lon: number;
  } | null>(null);
  const [over, setOver] = useState<string>("—");
  const [awayToast, setAwayToast] = useState<{
    seconds: number;
    km: number;
  } | null>(null);
  const hiddenAtRef = useRef<{ ms: number; velocity: number } | null>(null);
  const [hover, setHover] = useState<{
    ts: string;
    x: number;
    y: number;
  } | null>(null);
  const hoverClearTimerRef = useRef<number | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  const globeRef = useRef<GlobeHandle | null>(null);
  const didInitialCenter = useRef(false);
  const displayPosRef = useRef<{ lat: number; lon: number } | null>(null);
  const tweenRef = useRef<Tween | null>(null);

  useEffect(() => {
    const onResize = () =>
      setSize({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const windowMinRef = useRef(windowMin);
  useEffect(() => {
    windowMinRef.current = windowMin;
  }, [windowMin]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("iss_positions_window", {
        minutes_back: windowMin,
        target_points: SAMPLED_TARGET_POINTS,
      });
      if (cancelled) return;
      if (error) {
        console.error("window load failed", error);
        return;
      }
      setPositions((data ?? []) as IssPosition[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [windowMin]);

  useEffect(() => {
    const channel = supabase
      .channel("iss_positions_stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "iss_positions" },
        (payload) => {
          const row = payload.new as IssPosition;
          setPositions((prev) => {
            if (prev.some((p) => p.id === row.id)) return prev;
            const cutoff =
              Date.now() - windowMinRef.current * 60_000;
            const next = [...prev, row].filter(
              (p) => new Date(p.ts).getTime() >= cutoff,
            );
            return next.length > MAX_TRAIL_POINTS
              ? next.slice(next.length - MAX_TRAIL_POINTS)
              : next;
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const latest = positions[positions.length - 1];

  const visiblePositions = useMemo(() => {
    const cutoff = Date.now() - windowMin * 60_000;
    return positions.filter((p) => new Date(p.ts).getTime() >= cutoff);
  }, [positions, windowMin]);

  const activeColor =
    WINDOWS.find((w) => w.minutes === windowMin)?.color ?? "#ffbf47";

  useEffect(() => {
    if (!latest) return;

    const current = displayPosRef.current;
    if (!current) {
      // First data ever. If we have ≥2 points from the initial load, start tweening
      // between the last two so the marker is already in motion, instead of snapping
      // and waiting up to ~13s for the next Realtime insert.
      if (positions.length >= 2) {
        const prev = positions[positions.length - 2];
        const prevPos = { lat: prev.lat, lon: prev.lon };
        displayPosRef.current = prevPos;
        setDisplayPos(prevPos);
        tweenRef.current = {
          fromLat: prev.lat,
          fromLon: prev.lon,
          toLat: latest.lat,
          toLon: latest.lon,
          startMs: performance.now(),
          durationMs: EXPECTED_POLL_MS,
        };
      } else {
        const snap = { lat: latest.lat, lon: latest.lon };
        displayPosRef.current = snap;
        setDisplayPos(snap);
        tweenRef.current = null;
      }
    } else {
      tweenRef.current = {
        fromLat: current.lat,
        fromLon: current.lon,
        toLat: latest.lat,
        toLon: latest.lon,
        startMs: performance.now(),
        durationMs: EXPECTED_POLL_MS,
      };
    }

    if (!didInitialCenter.current && globeRef.current) {
      globeRef.current.pointOfView(
        { lat: latest.lat, lng: latest.lon, altitude: 2.4 },
        1200,
      );
      didInitialCenter.current = true;
    }
  }, [latest?.id, latest, positions]);

  useEffect(() => {
    if (!latest) return;
    let cancelled = false;
    reverseGeocode(latest.lat, latest.lon).then((label) => {
      if (!cancelled) setOver(label);
    });
    return () => {
      cancelled = true;
    };
  }, [latest?.id, latest]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = {
          ms: performance.now(),
          velocity: latest?.velocity_kmh ?? 27600,
        };
        tweenRef.current = null;
      } else if (
        document.visibilityState === "visible" &&
        hiddenAtRef.current
      ) {
        const { ms, velocity } = hiddenAtRef.current;
        hiddenAtRef.current = null;
        const seconds = (performance.now() - ms) / 1000;
        if (seconds > 5) {
          const km = (velocity * seconds) / 3600;
          setAwayToast({ seconds, km });
          setTimeout(() => setAwayToast(null), 10_000);
        }
        const current = displayPosRef.current;
        if (current && latest) {
          tweenRef.current = {
            fromLat: current.lat,
            fromLon: current.lon,
            toLat: latest.lat,
            toLon: latest.lon,
            startMs: performance.now(),
            durationMs: EXPECTED_POLL_MS,
          };
        }
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [latest]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = tweenRef.current;
      if (t) {
        const progress = Math.min(
          1,
          (performance.now() - t.startMs) / t.durationMs,
        );
        const next = slerp(t.fromLat, t.fromLon, t.toLat, t.toLon, progress);
        displayPosRef.current = next;
        setDisplayPos(next);
        if (progress >= 1) tweenRef.current = null;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const trailPath = useMemo(() => {
    if (visiblePositions.length < 2) return [];
    const segments: { coords: number[][] }[] = [];
    let current: number[][] = [];
    let lastMs = -Infinity;
    for (const p of visiblePositions) {
      const t = new Date(p.ts).getTime();
      if (current.length > 0 && t - lastMs > 60_000) {
        if (current.length >= 2) segments.push({ coords: current });
        current = [];
      }
      current.push([p.lat, p.lon, 0]);
      lastMs = t;
    }
    if (current.length >= 2) segments.push({ coords: current });
    return segments;
  }, [visiblePositions]);

  const globePoints = useMemo(() => {
    const trailPoints: {
      kind: "trail";
      lat: number;
      lng: number;
      alt: number;
      ts: string;
    }[] = [];
    let lastMs = -Infinity;
    for (const p of visiblePositions) {
      const t = new Date(p.ts).getTime();
      if (t - lastMs >= HOVER_DOT_INTERVAL_S * 1000) {
        trailPoints.push({
          kind: "trail",
          lat: p.lat,
          lng: p.lon,
          alt: 0,
          ts: p.ts,
        });
        lastMs = t;
      }
    }
    if (displayPos) {
      return [
        ...trailPoints,
        {
          kind: "iss" as const,
          lat: displayPos.lat,
          lng: displayPos.lon,
          alt: 0.06,
          ts: latest?.ts ?? "",
        },
      ];
    }
    return trailPoints;
  }, [visiblePositions, displayPos, latest?.ts]);

  const pathColors = useMemo(
    () => [`${activeColor}40`, `${activeColor}d9`],
    [activeColor],
  );

  const ringsData = useMemo(() => {
    if (!displayPos) return [];
    return [{ lat: displayPos.lat, lng: displayPos.lon }];
  }, [displayPos]);

  const visLabel = latest
    ? latest.visibility === "eclipsed"
      ? "ECLIPSED"
      : latest.visibility === "visible"
        ? "VISIBLE"
        : "SUNLIT"
    : "—";
  const visColor = latest
    ? latest.visibility === "eclipsed"
      ? "text-[#ff5a5a]"
      : latest.visibility === "visible"
        ? "text-[#5dd8f7]"
        : "text-[#ffbf47]"
    : "text-white/40";

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black font-[family-name:var(--font-geist-mono)] text-[#e4e4e4]">
      <Globe
        ref={globeRef as never}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        backgroundImageUrl="https://cdn.jsdelivr.net/npm/three-globe/example/img/night-sky.png"
        globeImageUrl="https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg"
        bumpImageUrl="https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png"
        pointsData={globePoints}
        pointAltitude={(d) => (d as { alt: number }).alt}
        pointRadius={(d) =>
          (d as { kind: "iss" | "trail" }).kind === "iss" ? 1.8 : 0.35
        }
        pointColor={(d) => {
          const p = d as { kind: "iss" | "trail" };
          if (p.kind === "iss")
            return latest?.visibility === "eclipsed" ? "#ff5a5a" : "#ffbf47";
          return "rgba(0,0,0,0)";
        }}
        pointsTransitionDuration={0}
        onPointHover={(d) => {
          const p = d as { kind: "iss" | "trail"; ts: string } | null;
          if (p && p.kind === "trail" && p.ts) {
            if (hoverClearTimerRef.current !== null) {
              window.clearTimeout(hoverClearTimerRef.current);
              hoverClearTimerRef.current = null;
            }
            setHover((prev) =>
              prev && prev.ts === p.ts
                ? prev
                : {
                    ts: p.ts,
                    x: mouseRef.current.x,
                    y: mouseRef.current.y,
                  },
            );
            return;
          }
          if (hoverClearTimerRef.current !== null) return;
          hoverClearTimerRef.current = window.setTimeout(() => {
            hoverClearTimerRef.current = null;
            setHover(null);
          }, 500);
        }}
        ringsData={ringsData}
        ringLat={(d) => (d as { lat: number }).lat}
        ringLng={(d) => (d as { lng: number }).lng}
        ringAltitude={0.061}
        ringColor={() => (t: number) => `rgba(255,191,71,${1 - t})`}
        ringMaxRadius={4}
        ringPropagationSpeed={2}
        ringRepeatPeriod={1400}
        pathsData={trailPath}
        pathPoints={(d) => (d as { coords: number[][] }).coords}
        pathPointLat={(p) => (p as number[])[0]}
        pathPointLng={(p) => (p as number[])[1]}
        pathPointAlt={(p) => (p as number[])[2]}
        pathColor={() => pathColors}
        pathStroke={1.5}
        pathTransitionDuration={0}
      />

      <div className="pointer-events-none absolute left-6 top-6 z-10 xl:left-1/2 xl:-translate-x-1/2">
        <div className="whitespace-nowrap text-2xl font-bold tracking-[0.3em] text-[#5dd8f7]">
          INTERNATIONAL SPACE STATION LIVE TRACKER
        </div>
      </div>

      <div className="pointer-events-none absolute right-24 top-6 z-10 flex h-12 items-center gap-2 text-[10px] tracking-[0.25em] text-white/60">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#ffbf47]" />
        TRACKING
      </div>

      <a
        href="https://wheretheiss.at/"
        target="_blank"
        rel="noopener noreferrer"
        className="pointer-events-auto absolute bottom-6 left-6 z-10 text-[10px] tracking-[0.25em] text-white/50 transition hover:text-[#5dd8f7]"
      >
        DATA SOURCE · wheretheiss.at ↗
      </a>

      <section className="pointer-events-none absolute left-6 top-1/2 z-10 flex h-[420px] w-64 -translate-y-1/2 flex-col border border-[#ffbf47]/25 bg-black/40 p-5 text-[12px] shadow-[0_0_20px_rgba(255,191,71,0.08)] backdrop-blur-sm">
        <div className="mb-4 text-[11px] tracking-[0.3em] text-white/50">
          ── TELEMETRY ──
        </div>
        {latest && displayPos ? (
          <dl className="flex flex-1 flex-col justify-between">
            <Row
              label="LATITUDE"
              value={`${Math.abs(displayPos.lat).toFixed(4)}° ${displayPos.lat >= 0 ? "N" : "S"}`}
            />
            <Row
              label="LONGITUDE"
              value={`${Math.abs(displayPos.lon).toFixed(4)}° ${displayPos.lon >= 0 ? "E" : "W"}`}
            />
            <Row
              label="ALTITUDE"
              value={`${latest.altitude_km.toFixed(1)} km`}
            />
            <Row
              label="VELOCITY"
              value={`${latest.velocity_kmh.toFixed(1)} km/h`}
            />
            <div className="flex justify-between gap-4">
              <dt className="text-white/40 tracking-[0.15em]">SUNLIGHT</dt>
              <dd className={`tabular-nums ${visColor}`}>{visLabel}</dd>
            </div>
            <Row label="OVER" value={over} />
          </dl>
        ) : (
          <div className="text-white/40 tracking-[0.15em]">AWAITING FIX…</div>
        )}
      </section>

      {hover && (
        <div
          className="pointer-events-none fixed z-30 border border-[#ffbf47]/60 bg-black/90 px-3 py-1.5 text-[10px] tracking-[0.2em] text-[#ffbf47] shadow-[0_0_15px_rgba(255,191,71,0.2)] backdrop-blur-sm"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          ISS WAS HERE · {timeAgo(hover.ts)}
        </div>
      )}

      {awayToast && (
        <button
          type="button"
          onClick={() => setAwayToast(null)}
          className="absolute bottom-10 left-1/2 z-20 -translate-x-1/2 border border-[#ffbf47]/60 bg-black/80 px-6 py-4 text-center font-[family-name:var(--font-geist-mono)] tracking-[0.15em] shadow-[0_0_30px_rgba(255,191,71,0.25)] backdrop-blur-sm"
        >
          <div className="text-[10px] text-white/50">
            YOU LOOKED AWAY FOR {formatDuration(awayToast.seconds)}
          </div>
          <div className="mt-1 text-sm tracking-[0.2em] text-[#ffbf47]">
            ISS TRAVELED {Math.round(awayToast.km)} KM
          </div>
          <div className="mt-2 text-[9px] tracking-[0.3em] text-white/30">
            CLICK TO DISMISS
          </div>
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          if (globeRef.current && displayPos) {
            globeRef.current.pointOfView(
              { lat: displayPos.lat, lng: displayPos.lon, altitude: 2.4 },
              1000,
            );
          }
        }}
        disabled={!displayPos}
        title="Center on ISS"
        className="pointer-events-auto absolute right-6 top-6 z-10 flex h-12 w-12 items-center justify-center border border-[#ffbf47]/30 bg-black/40 text-[#ffbf47] shadow-[0_0_20px_rgba(255,191,71,0.08)] backdrop-blur-sm transition hover:border-[#ffbf47] hover:bg-[#ffbf47]/10 disabled:opacity-40"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
          <line x1="12" y1="1.5" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="22.5" />
          <line x1="1.5" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="22.5" y2="12" />
        </svg>
      </button>

      <section className="pointer-events-auto absolute right-6 top-1/2 z-10 flex h-[420px] w-64 -translate-y-1/2 flex-col border border-[#ffbf47]/25 bg-black/40 p-5 text-[12px] shadow-[0_0_20px_rgba(255,191,71,0.08)] backdrop-blur-sm">
        <div className="mb-4 text-[11px] tracking-[0.3em] text-white/50">
          ── TRAIL ──
        </div>
        <ul className="space-y-2">
          {WINDOWS.map((w) => {
            const active = w.minutes === windowMin;
            return (
              <li key={w.minutes}>
                <button
                  type="button"
                  onClick={() => setWindowMin(w.minutes)}
                  className="flex w-full items-center gap-3 border px-3 py-2.5 text-xs tracking-[0.25em] transition hover:bg-white/5"
                  style={{
                    borderColor: active ? w.color : "rgba(255,255,255,0.12)",
                    backgroundColor: active ? `${w.color}1f` : "transparent",
                    color: active ? w.color : "rgba(228,228,228,0.7)",
                  }}
                >
                  <span
                    className="inline-block h-2 w-5 flex-shrink-0"
                    style={{ backgroundColor: w.color }}
                  />
                  <span>{w.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="tracking-[0.15em] text-white/40">{label}</dt>
      <dd className="tabular-nums text-[#ffbf47]">{value}</dd>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS === 0 ? `${m} min` : `${m} min ${remS} s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  const parts = [`${h} h`];
  if (remM > 0) parts.push(`${remM} min`);
  if (remS > 0) parts.push(`${remS} s`);
  return parts.join(" ");
}

function timeAgo(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s AGO`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} MIN AGO`;
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  return remMin === 0 ? `${h}h AGO` : `${h}h ${remMin}m AGO`;
}
