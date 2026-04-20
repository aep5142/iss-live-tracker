export function oceanFor(lat: number, lon: number): string {
  if (lat > 66) return "Arctic Ocean";
  if (lat < -60) return "Southern Ocean";
  if (lon >= 20 && lon <= 146 && lat < 30) return "Indian Ocean";
  if (lon > 146 || lon < -67) return "Pacific Ocean";
  return "Atlantic Ocean";
}
