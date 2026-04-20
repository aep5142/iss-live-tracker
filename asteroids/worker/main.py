import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

ISS_URL = "https://api.wheretheiss.at/v1/satellites/25544"
CREW_URL = "http://api.open-notify.org/astros.json"
POSITION_INTERVAL_S = 5
CREW_INTERVAL_S = 3600
CREW_STALE_AFTER = timedelta(hours=2)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("worker")

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


async def poll_positions(client: httpx.AsyncClient) -> None:
    while True:
        try:
            r = await client.get(ISS_URL, timeout=30)
            r.raise_for_status()
            d = r.json()
            row = {
                "ts": datetime.fromtimestamp(d["timestamp"], tz=timezone.utc).isoformat(),
                "lat": d["latitude"],
                "lon": d["longitude"],
                "altitude_km": d["altitude"],
                "velocity_kmh": d["velocity"],
                "visibility": d["visibility"],
            }
            sb.table("iss_positions").insert(row).execute()
            log.info("position lat=%.3f lon=%.3f vis=%s", row["lat"], row["lon"], row["visibility"])
        except Exception as e:
            log.warning("position poll failed: %s: %s", type(e).__name__, e)
        await asyncio.sleep(POSITION_INTERVAL_S)


async def poll_crew(client: httpx.AsyncClient) -> None:
    while True:
        try:
            r = await client.get(CREW_URL, timeout=30)
            r.raise_for_status()
            d = r.json()
            rows = [{"name": p["name"], "craft": p["craft"]} for p in d.get("people", [])]
            if rows:
                sb.table("iss_crew").upsert(rows, on_conflict="name,craft").execute()
                cutoff = (datetime.now(timezone.utc) - CREW_STALE_AFTER).isoformat()
                sb.table("iss_crew").delete().lt("updated_at", cutoff).execute()
                log.info("crew upserted (%d)", len(rows))
        except Exception as e:
            log.warning("crew poll failed: %s", e)
        await asyncio.sleep(CREW_INTERVAL_S)


async def main() -> None:
    async with httpx.AsyncClient() as client:
        await asyncio.gather(poll_positions(client), poll_crew(client))


if __name__ == "__main__":
    asyncio.run(main())
