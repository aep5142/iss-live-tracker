"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { supabase, type IssPosition, type IssCrewMember } from "@/lib/supabase";
import { reverseGeocode } from "@/lib/geocode";

const Globe = dynamic(() => import("react-globe.gl"), { ssr: false });

const TRAIL_WINDOW_MINUTES = 90;
const MAX_TRAIL_POINTS = 1200;
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
  const [crew, setCrew] = useState<IssCrewMember[]>([]);
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

  useEffect(() => {
    (async () => {
      const since = new Date(
        Date.now() - TRAIL_WINDOW_MINUTES * 60_000,
      ).toISOString();
      const { data, error } = await supabase
        .from("iss_positions")
        .select("*")
        .gte("ts", since)
        .order("ts", { ascending: true });
      if (error) {
        console.error("initial positions load failed", error);
        return;
      }
      setPositions((data ?? []) as IssPosition[]);
    })();

    const channel = supabase
      .channel("iss_positions_stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "iss_positions" },
        (payload) => {
          const row = payload.new as IssPosition;
          setPositions((prev) => {
            const cutoff = Date.now() - TRAIL_WINDOW_MINUTES * 60_000;
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

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("iss_crew")
        .select("name, craft")
        .eq("craft", "ISS")
        .order("name", { ascending: true });
      if (error) {
        console.error("crew load failed", error);
        return;
      }
      setCrew((data ?? []) as IssCrewMember[]);
    })();

    const channel = supabase
      .channel("iss_crew_stream")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "iss_crew" },
        async () => {
          const { data } = await supabase
            .from("iss_crew")
            .select("name, craft")
            .eq("craft", "ISS")
            .order("name", { ascending: true });
          if (data) setCrew(data as IssCrewMember[]);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const latest = positions[positions.length - 1];

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
    if (positions.length < 2) return [];
    const coords = positions.map((p) => [p.lat, p.lon, 0.02]);
    return [{ coords }];
  }, [positions]);

  const globePoints = useMemo(() => {
    const trailPoints: {
      kind: "trail";
      lat: number;
      lng: number;
      alt: number;
      ts: string;
    }[] = [];
    let lastMs = -Infinity;
    for (const p of positions) {
      const t = new Date(p.ts).getTime();
      if (t - lastMs >= HOVER_DOT_INTERVAL_S * 1000) {
        trailPoints.push({
          kind: "trail",
          lat: p.lat,
          lng: p.lon,
          alt: 0.02,
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
  }, [positions, displayPos, latest?.ts]);

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
          (d as { kind: "iss" | "trail" }).kind === "iss" ? 0.6 : 1.0
        }
        pointColor={(d) => {
          const p = d as { kind: "iss" | "trail" };
          if (p.kind === "iss")
            return latest?.visibility === "eclipsed" ? "#ff5a5a" : "#ffbf47";
          return "rgba(255,191,71,0.3)";
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
        pathsData={trailPath}
        pathPoints={(d) => (d as { coords: number[][] }).coords}
        pathPointLat={(p) => (p as number[])[0]}
        pathPointLng={(p) => (p as number[])[1]}
        pathPointAlt={(p) => (p as number[])[2]}
        pathColor={() => ["rgba(255,191,71,0.25)", "rgba(255,191,71,0.85)"]}
        pathStroke={1.5}
        pathTransitionDuration={0}
      />

      <header className="pointer-events-none absolute left-6 top-6 z-10">
        <div className="text-sm font-semibold tracking-[0.2em] text-[#5dd8f7]">
          ISS LIVE TRACKER
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] tracking-[0.15em] text-white/50">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[#ffbf47]" />
          TRACKING · wheretheiss.at
        </div>
      </header>

      <section className="pointer-events-none absolute left-6 top-24 z-10 w-72 border border-[#ffbf47]/25 bg-black/40 p-4 text-[11px] shadow-[0_0_20px_rgba(255,191,71,0.08)] backdrop-blur-sm">
        <div className="mb-3 text-[10px] tracking-[0.25em] text-white/40">
          ── TELEMETRY ──
        </div>
        {latest && displayPos ? (
          <dl className="space-y-1.5">
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

      <section className="pointer-events-none absolute right-6 top-6 z-10 w-56 border border-[#ffbf47]/25 bg-black/40 p-4 text-[11px] shadow-[0_0_20px_rgba(255,191,71,0.08)] backdrop-blur-sm">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[10px] tracking-[0.25em] text-white/40">
            ── CREW ──
          </span>
          <span className="tabular-nums text-[#ffbf47]">{crew.length}</span>
        </div>
        <ul className="space-y-1 text-right">
          {crew.map((c) => (
            <li key={c.name} className="text-[#e4e4e4]/90">
              {c.name}
            </li>
          ))}
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
