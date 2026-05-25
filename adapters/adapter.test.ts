/**
 * Tests for prayer times adapters.
 * Run with: bun test
 */

import { describe, expect, it } from "bun:test";
import { aladhanAdapter, COUNTRY_METHOD } from "./aladhan";
import { myquranAdapter } from "./myquran";
import type { PrayerTimesAdapter } from "./types";

// ── Adapter structure ────────────────────────────────────────────────────────

describe("adapter structure", () => {
  const adapters: PrayerTimesAdapter[] = [aladhanAdapter, myquranAdapter];

  it("all adapters have required fields", () => {
    for (const a of adapters) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.name).toBe("string");
      expect(typeof a.priority).toBe("number");
      expect(typeof a.capabilities).toBe("object");
      expect(typeof a.healthCheck).toBe("function");
      expect(typeof a.searchCity).toBe("function");
      expect(typeof a.getTimings).toBe("function");
    }
  });

  it("aladhan has full capabilities", () => {
    expect(aladhanAdapter.capabilities.coords).toBe(true);
    expect(aladhanAdapter.capabilities.global).toBe(true);
    expect(aladhanAdapter.capabilities.method).toBe(true);
  });

  it("myquran has limited capabilities", () => {
    expect(myquranAdapter.capabilities.coords).toBe(false);
    expect(myquranAdapter.capabilities.global).toBe(false);
    expect(myquranAdapter.capabilities.method).toBe(false);
  });

  it("aladhan has higher priority than myquran", () => {
    expect(aladhanAdapter.priority).toBeGreaterThan(myquranAdapter.priority);
  });
});

// ── myquran adapter (live API) ───────────────────────────────────────────────

describe("myquran adapter", () => {
  it("healthCheck returns true", async () => {
    const ok = await myquranAdapter.healthCheck();
    expect(ok).toBe(true);
  });

  it("searchCity returns results for 'tangerang'", async () => {
    const results = await myquranAdapter.searchCity("tangerang");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBeString();
    expect(results[0].name.toLowerCase()).toInclude("tangerang");
    expect(results[0].country).toBe("Indonesia");
  });

  it("searchCity returns empty for nonsense query", async () => {
    const results = await myquranAdapter.searchCity("xyznonexistent123");
    expect(results.length).toBe(0);
  });

  it("getTimings returns 5 prayer times", async () => {
    // South Tangerang = 1108
    const timings = await myquranAdapter.getTimings("1108", new Date());
    expect(Object.keys(timings)).toEqual(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]);
    // All should be HH:MM format
    for (const v of Object.values(timings)) {
      expect(v).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("getTimings throws on invalid city ID", async () => {
    await expect(myquranAdapter.getTimings("99999", new Date())).rejects.toThrow();
  });
});

// ── aladhan COUNTRY_METHOD ──────────────────────────────────────────────────

describe("COUNTRY_METHOD", () => {
  it("returns 20 for Indonesia", () => {
    expect(COUNTRY_METHOD["indonesia"]).toBe(20);
  });

  it("contains major countries", () => {
    expect(COUNTRY_METHOD["malaysia"]).toBe(17);
    expect(COUNTRY_METHOD["usa"]).toBe(2);
    expect(COUNTRY_METHOD["uk"]).toBe(15);
  });
});
