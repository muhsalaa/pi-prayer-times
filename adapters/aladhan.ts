/**
 * Aladhan.com Prayer Times Adapter.
 * Full-featured: global coverage, coords, method selection.
 *
 * API docs: https://aladhan.com/prayer-times-api
 */

import type { PrayerTimesAdapter, AdapterCapabilities, CityResult } from "./types";

const BASE = "https://api.aladhan.com";
const TIMEOUT_MS = 10_000;

const CAPS: AdapterCapabilities = {
  coords: true,
  global: true,
  method: true,
};

/** Country → calculation method ID (subset — see aladhan docs for full list) */
export const COUNTRY_METHOD: Record<string, number> = {
  indonesia: 20,
  malaysia: 17,
  singapore: 11,
  brunei: 17,
  "saudi arabia": 4,
  uae: 4,
  qatar: 4,
  kuwait: 4,
  bahrain: 4,
  oman: 4,
  usa: 2,
  "united states": 2,
  canada: 2,
  uk: 15,
  "united kingdom": 15,
  france: 12,
  turkey: 13,
  egypt: 5,
  pakistan: 1,
  bangladesh: 1,
  india: 1,
  iran: 7,
  germany: 3,
  australia: 3,
  japan: 3,
  "south korea": 3,
};

/** Aladhan prayer name → our normalized key */
const KEY_MAP: Record<string, string> = {
  Fajr: "Fajr",
  Dhuhr: "Dhuhr",
  Asr: "Asr",
  Maghrib: "Maghrib",
  Isha: "Isha",
};

function fmtDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

async function fetchJSON(url: string, signal?: AbortSignal): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: signal ?? ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchTimings(url: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const json = await fetchJSON(url, signal);
  if (json.code !== 200) throw new Error(json.status ?? "API error");
  const out: Record<string, string> = {};
  const timings = json.data.timings;
  for (const apiKey of Object.keys(KEY_MAP)) {
    if (timings[apiKey]) out[KEY_MAP[apiKey]] = timings[apiKey];
  }
  return out;
}

export const aladhanAdapter: PrayerTimesAdapter = {
  id: "aladhan",
  name: "Aladhan.com",
  priority: 10,
  capabilities: CAPS,

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  async searchCity(query: string, country?: string): Promise<CityResult[]> {
    // Aladhan has no native city search. Return an exact-match result.
    const q = query.trim();
    if (!q) return [];
    const c = (country ?? "").trim();
    const id = c ? `${q}|${c}` : q;
    return [{ id, name: q, country: c || undefined }];
  },

  async getTimings(cityId: string, date: Date): Promise<Record<string, string>> {
    const parts = cityId.split("|");
    const city = parts[0];
    const country = parts[1] ?? "";
    const url = `${BASE}/v1/timingsByCity/${fmtDate(date)}?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${COUNTRY_METHOD[country.toLowerCase().trim()] ?? 3}`;
    return fetchTimings(url);
  },

  async getTimingsByCoords(lat: number, lon: number, date: Date): Promise<Record<string, string>> {
    const url = `${BASE}/v1/timings/${fmtDate(date)}?latitude=${lat}&longitude=${lon}&method=3`;
    return fetchTimings(url);
  },
};
