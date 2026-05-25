/**
 * Prayer Times Adapter Interface.
 * Each adapter wraps a prayer times API (aladhan, myquran, etc).
 */

export interface AdapterCapabilities {
  /** Can fetch by lat/lon coordinates */
  coords: boolean;
  /** Supports countries outside Indonesia (global coverage) */
  global: boolean;
  /** Supports calculation method selection */
  method: boolean;
}

export interface CityResult {
  /** Adapter-specific identifier for getTimings() */
  id: string;
  /** Human-readable city name */
  name: string;
  /** Region/province/state */
  region?: string;
  /** Country name */
  country?: string;
  /** Coordinates (if known) */
  lat?: number;
  lon?: number;
}

export interface PrayerTimesAdapter {
  /** Unique adapter ID (e.g. "aladhan", "myquran") */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Higher priority = tried first */
  readonly priority: number;
  /** What this adapter supports */
  readonly capabilities: AdapterCapabilities;

  /**
   * Quick health check. Returns true if the API is reachable and responsive.
   * Should be fast (< 5s) — used at init to probe which adapter works.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Search for cities matching a query string.
   * For APIs without native search (e.g. aladhan), returns an exact-match
   * result wrapping the query — the adapter trusts the user knows the city name.
   * Returns empty array if no matches.
   */
  searchCity(query: string, country?: string): Promise<CityResult[]>;

  /**
   * Get prayer timings for a city (identified by adapter-specific ID).
   * Returns normalized prayer names → "HH:MM" times.
   * Keys: "Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"
   */
  getTimings(cityId: string, date: Date): Promise<Record<string, string>>;

  /**
   * Get prayer timings by coordinates.
   * Returns null if unsupported by this adapter.
   */
  getTimingsByCoords?(lat: number, lon: number, date: Date): Promise<Record<string, string> | null>;
}
