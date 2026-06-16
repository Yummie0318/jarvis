import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// ─── Weather code map ─────────────────────────────────────────────────────────

const WEATHER_CODES: Record<number, string> = {
  0:  "Clear sky",
  1:  "Mainly clear",
  2:  "Partly cloudy",
  3:  "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Heavy freezing drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with light hail",
  99: "Thunderstorm with heavy hail",
};

// ─── Cache (simple in-memory, resets on cold start) ───────────────────────────

interface CacheEntry {
  data: object;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCached(key: string): object | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: object): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = searchParams.get("lat");
    const lon = searchParams.get("lon");

    if (!lat || !lon) {
      return NextResponse.json(
        { error: "Missing 'lat' or 'lon' query parameters." },
        { status: 400 }
      );
    }

    // Validate coordinates
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    if (isNaN(latNum) || isNaN(lonNum) || latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
      return NextResponse.json(
        { error: "Invalid coordinates." },
        { status: 400 }
      );
    }

    // Round for cache key (≈1km precision)
    const cacheKey = `${latNum.toFixed(2)},${lonNum.toFixed(2)}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { "X-Cache": "HIT", "Cache-Control": "public, max-age=600" },
      });
    }

    // Fetch weather + reverse geocode in parallel
    const [weatherRes, geoRes] = await Promise.allSettled([
      fetch(
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${latNum}&longitude=${lonNum}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min` +
        `&timezone=auto`,
        { next: { revalidate: 600 } }
      ),
      fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latNum}&lon=${lonNum}&format=json&zoom=10`,
        {
          headers: {
            "User-Agent": "JarvisAI/1.0 (contact@jarvis.local)",
            "Accept-Language": "en",
          },
        }
      ),
    ]);

    // Weather is required
    if (weatherRes.status === "rejected" || !weatherRes.value.ok) {
      const reason =
        weatherRes.status === "rejected"
          ? weatherRes.reason
          : await weatherRes.value.text();
      console.error("[weather] Open-Meteo failed:", reason);
      return NextResponse.json({ error: "Weather service unavailable." }, { status: 502 });
    }

    const weatherData = await weatherRes.value.json();

    // Geocoding is optional — degrade gracefully
    let geoData: Record<string, unknown> | null = null;
    if (geoRes.status === "fulfilled" && geoRes.value.ok) {
      geoData = await geoRes.value.json();
    }

    const code = weatherData?.current?.weather_code;
    const description = WEATHER_CODES[code] ?? "Unknown conditions";

    const address = (geoData?.address ?? {}) as Record<string, string>;
    const locationPayload = {
      city:    address.city    || address.town    || address.village || address.municipality || null,
      region:  address.state   || address.county  || null,
      country: address.country || null,
    };

    const payload = {
      temperature: weatherData?.current?.temperature_2m      ?? null,
      feelsLike:   weatherData?.current?.apparent_temperature ?? null,
      humidity:    weatherData?.current?.relative_humidity_2m ?? null,
      windSpeed:   weatherData?.current?.wind_speed_10m       ?? null,
      description,
      todayHigh:   weatherData?.daily?.temperature_2m_max?.[0] ?? null,
      todayLow:    weatherData?.daily?.temperature_2m_min?.[0] ?? null,
      units: {
        temperature: weatherData?.current_units?.temperature_2m  ?? "°C",
        windSpeed:   weatherData?.current_units?.wind_speed_10m  ?? "km/h",
      },
      location: locationPayload,
    };

    setCache(cacheKey, payload);

    return NextResponse.json(payload, {
      headers: { "X-Cache": "MISS", "Cache-Control": "public, max-age=600" },
    });

  } catch (err) {
    console.error("[weather] Unexpected error:", err);
    return NextResponse.json(
      { error: "Something went wrong fetching weather data." },
      { status: 500 }
    );
  }
}