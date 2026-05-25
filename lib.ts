/**
 * Pure logic for pi-prayer-times.
 * Extracted for testability — no side effects, no pi runtime dependencies.
 */

export const PRAYER_NAMES = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;
export type PrayerName = (typeof PRAYER_NAMES)[number];



const MAX_STALE_DAYS = 2;

/** Parse "HH:MM" into a Date using the given reference date */
export function timeToDate(timeStr: string, ref: Date = new Date()): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date(ref);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Milliseconds from `now` until `targetTime` ("HH:MM"). If passed today, wraps to tomorrow. */
export function msUntil(targetTime: string, now: Date = new Date()): number {
  const target = timeToDate(targetTime, now);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/** Format ms as "XXh XXm", "Xm", or "< 1m" */
export function formatCountdown(ms: number): string {
  const totalMins = Math.floor(ms / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0 && m === 0) return "< 1m";
  return h > 0 ? `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Today's date as "YYYY-MM-DD" */
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}



export interface CacheEntry {
  date: string;
  timings: Record<string, string>;
  fetchedAt: number;
  adzanPlayed?: string[];
}

/** Returns whether the cache is valid (today), stale (within MAX_STALE_DAYS), or neither */
export function cacheStatus(cache: CacheEntry | null): "valid" | "stale" | "none" {
  if (!cache) return "none";
  if (cache.date === todayStr()) return "valid";
  const age = Math.floor((Date.now() - new Date(cache.date).getTime()) / 86_400_000);
  return age <= MAX_STALE_DAYS ? "stale" : "none";
}

/** True if midnight has passed since the given cache date */
export function midnightPassedSince(cacheDate: string | null): boolean {
  return !cacheDate || cacheDate !== todayStr();
}

/** Find the next upcoming prayer and its time */
export function findNext(
  timings: Record<string, string>,
  now: Date = new Date(),
): { name: PrayerName; time: string } | null {
  let best: { name: PrayerName; time: string; ms: number } | null = null;
  for (const name of PRAYER_NAMES) {
    const t = timings[name];
    if (!t) continue;
    const ms = msUntil(t, now);
    if (!best || ms < best.ms) best = { name, time: t, ms };
  }
  return best ? { name: best.name, time: best.time } : null;
}

/** If within `windowMin` minutes after a prayer, return that prayer's name */
export function inPrayerWindow(
  timings: Record<string, string>,
  windowMin: number,
  now: Date = new Date(),
): PrayerName | null {
  for (const name of PRAYER_NAMES) {
    const t = timings[name];
    if (!t) continue;
    const diff = now.getTime() - timeToDate(t, now).getTime();
    if (diff >= 0 && diff < windowMin * 60_000) return name;
  }
  return null;
}
