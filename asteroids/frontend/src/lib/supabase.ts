import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, anon, {
  realtime: { params: { eventsPerSecond: 10 } },
});

export type IssPosition = {
  id: number;
  ts: string;
  lat: number;
  lon: number;
  altitude_km: number;
  velocity_kmh: number;
  visibility: "daylight" | "eclipsed" | "visible";
};

export type IssCrewMember = {
  name: string;
  craft: string;
};
