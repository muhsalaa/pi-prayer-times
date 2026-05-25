/**
 * MyQuran Prayer Times Adapter.
 * Indonesia-only. Uses Kemenag RI calculation method.
 *
 * API: https://api.myquran.com/v2/sholat
 * No official docs — community-maintained.
 */

import type { PrayerTimesAdapter, AdapterCapabilities, CityResult } from "./types";

const BASE = "https://api.myquran.com/v2/sholat";
const TIMEOUT_MS = 10_000;

const CAPS: AdapterCapabilities = {
  coords: false,
  global: false,
  method: false,
};

/** MyQuran prayer key → our normalized key */
const KEY_MAP: Record<string, string> = {
  subuh: "Fajr",
  dzuhur: "Dhuhr",
  ashar: "Asr",
  maghrib: "Maghrib",
  isya: "Isha",
};

async function fetchJSON(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export const myquranAdapter: PrayerTimesAdapter = {
  id: "myquran",
  name: "MyQuran",
  priority: 5,
  capabilities: CAPS,

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(BASE + "/kota/semua", { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  async searchCity(query: string): Promise<CityResult[]> {
    const q = query.trim();
    if (!q) return [];
    const json = await fetchJSON(`${BASE}/kota/cari/${encodeURIComponent(q)}`);
    if (!json.status || !Array.isArray(json.data)) return [];
    return json.data.map((c: { id: string; lokasi: string }) => ({
      id: String(c.id),
      name: c.lokasi,
      country: "Indonesia",
    }));
  },

  async getTimings(cityId: string, date: Date): Promise<Record<string, string>> {
    const url = `${BASE}/jadwal/${cityId}/${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
    const json = await fetchJSON(url);
    if (!json.status || !json.data?.jadwal) throw new Error("Invalid response");
    const jadwal = json.data.jadwal;
    const out: Record<string, string> = {};
    for (const [srcKey, dstKey] of Object.entries(KEY_MAP)) {
      if (jadwal[srcKey]) out[dstKey] = jadwal[srcKey];
    }
    return out;
  },
};
