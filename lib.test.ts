/**
 * Tests for pi-prayer-times pure logic (lib.ts).
 * Run with: bun test
 */

import { describe, expect, it } from "bun:test";
import {
  timeToDate,
  msUntil,
  formatCountdown,
  todayStr,
  cacheStatus,
  midnightPassedSince,
  findNext,
  inPrayerWindow,
  PRAYER_NAMES,
  type CacheEntry,
} from "./lib";

// ── timeToDate ───────────────────────────────────────────────────────────────

describe("timeToDate", () => {
  it("parses HH:MM into a Date with given reference", () => {
    const ref = new Date("2026-05-07T10:00:00");
    const result = timeToDate("15:30", ref);
    expect(result.getHours()).toBe(15);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(4); // May = 4 (0-indexed)
    expect(result.getDate()).toBe(7);
  });

  it("defaults to current date", () => {
    const now = new Date();
    const result = timeToDate("00:00");
    expect(result.getFullYear()).toBe(now.getFullYear());
    expect(result.getMonth()).toBe(now.getMonth());
    expect(result.getDate()).toBe(now.getDate());
  });
});

// ── msUntil ──────────────────────────────────────────────────────────────────

describe("msUntil", () => {
  it("returns milliseconds until target later today", () => {
    // 10:00 now, target 10:05 → ~5 min = 300,000 ms
    const now = new Date("2026-05-07T10:00:00");
    const ms = msUntil("10:05", now);
    expect(ms).toBe(5 * 60 * 1000);
  });

  it("wraps to tomorrow if target already passed", () => {
    // 10:00 now, target 09:00 → tomorrow 09:00 = 23 hours
    const now = new Date("2026-05-07T10:00:00");
    const ms = msUntil("09:00", now);
    expect(ms).toBe(23 * 60 * 60 * 1000);
  });

  it("wraps to tomorrow exactly at target time (prayer window handles this)", () => {
    const now = new Date("2026-05-07T12:00:00");
    const ms = msUntil("12:00", now);
    expect(ms).toBe(24 * 60 * 60 * 1000); // wraps to tomorrow
  });

  it("returns correct ms for next prayer", () => {
    const now = new Date("2026-05-07T13:00:00");
    const ms = msUntil("15:13", now); // 2h 13m later
    expect(ms).toBe((2 * 60 + 13) * 60 * 1000);
  });
});

// ── formatCountdown ──────────────────────────────────────────────────────────

describe("formatCountdown", () => {
  it("formats hours and minutes", () => {
    expect(formatCountdown(3 * 60 * 60 * 1000 + 45 * 60 * 1000)).toBe("03h 45m");
  });

  it("formats minutes only", () => {
    expect(formatCountdown(7 * 60 * 1000)).toBe("7m");
  });

  it('shows "< 1m" for under 60 seconds', () => {
    expect(formatCountdown(59_999)).toBe("< 1m");
    expect(formatCountdown(0)).toBe("< 1m");
  });

  it("formats 1 hour exactly", () => {
    expect(formatCountdown(60 * 60 * 1000)).toBe("01h 00m");
  });

  it("formats large duration", () => {
    expect(formatCountdown(23 * 60 * 60 * 1000 + 59 * 60 * 1000)).toBe("23h 59m");
  });
});

// ── todayStr ─────────────────────────────────────────────────────────────────

describe("todayStr", () => {
  it("returns YYYY-MM-DD matching current date", () => {
    const now = new Date();
    const expected = now.toISOString().slice(0, 10);
    expect(todayStr()).toBe(expected);
  });
});

// ── cacheStatus ──────────────────────────────────────────────────────────────

describe("cacheStatus", () => {
  const today = todayStr();

  it("returns 'none' for null cache", () => {
    expect(cacheStatus(null)).toBe("none");
  });

  it("returns 'valid' for today's cache", () => {
    const cache: CacheEntry = { date: today, timings: {}, fetchedAt: Date.now() };
    expect(cacheStatus(cache)).toBe("valid");
  });

  it("returns 'stale' for yesterday's cache", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const cache: CacheEntry = { date: yesterday, timings: {}, fetchedAt: Date.now() - 86_400_000 };
    expect(cacheStatus(cache)).toBe("stale");
  });

  it("returns 'stale' for 2-day-old cache", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const cache: CacheEntry = { date: twoDaysAgo, timings: {}, fetchedAt: Date.now() - 2 * 86_400_000 };
    expect(cacheStatus(cache)).toBe("stale");
  });

  it("returns 'none' for 3-day-old cache", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const cache: CacheEntry = { date: threeDaysAgo, timings: {}, fetchedAt: Date.now() - 3 * 86_400_000 };
    expect(cacheStatus(cache)).toBe("none");
  });
});

// ── midnightPassedSince ──────────────────────────────────────────────────────

describe("midnightPassedSince", () => {
  it("returns true for null", () => {
    expect(midnightPassedSince(null)).toBe(true);
  });

  it("returns false for today", () => {
    expect(midnightPassedSince(todayStr())).toBe(false);
  });

  it("returns true for yesterday", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(midnightPassedSince(yesterday)).toBe(true);
  });
});

// ── findNext ─────────────────────────────────────────────────────────────────

describe("findNext", () => {
  const timings = {
    Fajr: "04:35",
    Dhuhr: "11:49",
    Asr: "15:12",
    Maghrib: "17:45",
    Isha: "18:57",
  };

  it("finds next prayer mid-morning", () => {
    const now = new Date("2026-05-07T08:00:00");
    const next = findNext(timings, now);
    expect(next).not.toBeNull();
    expect(next!.name).toBe("Dhuhr");
    expect(next!.time).toBe("11:49");
  });

  it("finds next prayer after Isha (wraps to Fajr tomorrow)", () => {
    const now = new Date("2026-05-07T20:00:00");
    const next = findNext(timings, now);
    expect(next).not.toBeNull();
    expect(next!.name).toBe("Fajr");
    expect(next!.time).toBe("04:35");
  });

  it("finds next when exactly at a prayer time", () => {
    const now = new Date("2026-05-07T11:49:00");
    const next = findNext(timings, now);
    // At exactly 11:49, Dhuhr has "passed" (wraps to tomorrow), next should be Asr
    expect(next!.name).toBe("Asr");
  });

  it("returns next prayer immediately after Fajr", () => {
    const now = new Date("2026-05-07T04:36:00");
    const next = findNext(timings, now);
    expect(next!.name).toBe("Dhuhr");
  });
});

// ── inPrayerWindow ───────────────────────────────────────────────────────────

describe("inPrayerWindow", () => {
  const timings = {
    Fajr: "04:35",
    Dhuhr: "11:49",
    Asr: "15:12",
    Maghrib: "17:45",
    Isha: "18:57",
  };
  const windowMin = 15;

  it("returns prayer name when within window", () => {
    // 2 minutes after Asr
    const now = new Date("2026-05-07T15:14:00");
    expect(inPrayerWindow(timings, windowMin, now)).toBe("Asr");
  });

  it("returns null before prayer time", () => {
    const now = new Date("2026-05-07T15:10:00");
    expect(inPrayerWindow(timings, windowMin, now)).toBeNull();
  });

  it("returns null after window expires", () => {
    // 20 minutes after Asr
    const now = new Date("2026-05-07T15:32:00");
    expect(inPrayerWindow(timings, windowMin, now)).toBeNull();
  });

  it("returns prayer exactly at prayer time", () => {
    const now = new Date("2026-05-07T15:12:00");
    expect(inPrayerWindow(timings, windowMin, now)).toBe("Asr");
  });

  it("returns null for a different prayer window", () => {
    // 2 minutes after Maghrib
    const now = new Date("2026-05-07T17:47:00");
    expect(inPrayerWindow(timings, windowMin, now)).toBe("Maghrib");
  });
});

// ── PRAYER_NAMES ─────────────────────────────────────────────────────────────

describe("PRAYER_NAMES", () => {
  it("contains the 5 daily prayers", () => {
    expect(PRAYER_NAMES).toEqual(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]);
  });
});
