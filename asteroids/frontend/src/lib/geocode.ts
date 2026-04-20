import { oceanFor } from "./oceans";

const cache = new Map<string, string>();

export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<string> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const r = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
    );
    if (!r.ok) throw new Error(`http ${r.status}`);
    const d = await r.json();
    const raw =
      typeof d?.countryName === "string" && d.countryName.length > 0
        ? d.countryName
        : oceanFor(lat, lon);
    const label = raw.replace(/\s*\([^)]*\)/g, "").trim();
    cache.set(key, label);
    return label;
  } catch {
    const fallback = oceanFor(lat, lon);
    cache.set(key, fallback);
    return fallback;
  }
}
