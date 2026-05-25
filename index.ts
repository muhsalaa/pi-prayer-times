/**
 * Prayer Times Extension for pi coding agent.
 *
 * Adapter-based architecture: probes aladhan.com first, falls back to myquran.
 * See README.md for full documentation.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  PRAYER_NAMES,
  type PrayerName,
  type CacheEntry,
  timeToDate,
  msUntil,
  formatCountdown,
  todayStr,
  cacheStatus,
  midnightPassedSince,
  findNext,
  inPrayerWindow,
} from "./lib";
import type { PrayerTimesAdapter, CityResult } from "./adapters/types";
import { aladhanAdapter } from "./adapters/aladhan";
import { myquranAdapter } from "./adapters/myquran";

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(os.homedir(), ".pi", "prayer-times-cache.json");
const CONFIG_PATH = path.join(os.homedir(), ".pi", "prayer-times-config.json");
const ADZAN_LOCK_PATH = path.join(os.homedir(), ".pi", "prayer-times-adzan.lock");
const UPDATE_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

/** All available adapters, sorted by priority (highest first) */
const ALL_ADAPTERS: PrayerTimesAdapter[] = [aladhanAdapter, myquranAdapter];

interface Config {
  adapter: string;
  cityId: string;
  cityName: string;
  country?: string;
  lat?: number;
  lon?: number;
}

// ── Cache I/O ────────────────────────────────────────────────────────────────

function loadCache(): CacheEntry | null {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")); } catch { return null; }
}
function saveCache(entry: CacheEntry): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(entry, null, 2));
}

// ── Config I/O ───────────────────────────────────────────────────────────────

/** Load and migrate config (handles old aladhan-only format) */
function loadConfig(): Config | null {
  try {
    const raw: any = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    // Migrate old format: { city, country, lat?, lon? } → new Config shape
    if (!raw.adapter || !raw.cityId) {
      raw.cityName = raw.cityName || raw.city || "Unknown";
      raw.country = raw.country || "Indonesia";
      raw.adapter = raw.adapter || "";
      raw.cityId = raw.cityId || "";
    }
    return raw as Config;
  } catch { return null; }
}
function saveConfig(config: Config): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ── Audio ────────────────────────────────────────────────────────────────────

function getAdzanPath(pi: ExtensionAPI): string {
  const f = pi.getFlag("adzan-path");
  if (typeof f === "string" && f.length > 0) return f;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "adzan.mp3");
}

function playAdzan(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  exec(`ffplay -nodisp -autoexit -loglevel quiet "${filePath}"`, (err) => {
    if (err) console.error("[prayer-times] ffplay error:", err.message);
  });
}

function tryAcquireAdzanLock(prayer: string): boolean {
  const date = todayStr();
  try {
    fs.mkdirSync(path.dirname(ADZAN_LOCK_PATH), { recursive: true });
    fs.writeFileSync(ADZAN_LOCK_PATH, JSON.stringify({ prayer, date, ts: Date.now() }), { flag: "wx" });
    return true;
  } catch (err: any) {
    if (err.code !== "EEXIST") return false;
    try {
      const lock = JSON.parse(fs.readFileSync(ADZAN_LOCK_PATH, "utf-8"));
      if (lock.prayer === prayer && lock.date === date) return false;
      fs.unlinkSync(ADZAN_LOCK_PATH);
      fs.writeFileSync(ADZAN_LOCK_PATH, JSON.stringify({ prayer, date, ts: Date.now() }), { flag: "wx" });
      return true;
    } catch { return false; }
  }
}

// ── IP Geolocation ──────────────────────────────────────────────────────────

async function detectLocation(): Promise<{ city: string; country: string; lat: number; lon: number } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch("http://ip-api.com/json", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "success" || !data.city || !data.country) return null;
    return { city: data.city, country: data.country, lat: data.lat, lon: data.lon };
  } catch (err: any) {
    if (err?.name !== "AbortError" && err?.name !== "TypeError") {
      console.error("[prayer-times] IP detection error:", err);
    }
    return null;
  }
}

// ── Cached config ─────────────────────────────────────────────────────────

let _cachedConfig: Config | null | undefined;
function getConfig(): Config | null {
  if (_cachedConfig !== undefined) return _cachedConfig;
  _cachedConfig = loadConfig();
  return _cachedConfig;
}
function setConfig(cfg: Config): void {
  _cachedConfig = cfg;
  saveConfig(cfg);
}
function invalidateConfig(): void {
  _cachedConfig = undefined;
}

// ── Adapter Resolution ───────────────────────────────────────────────────────

async function probeAdapter(adapter: PrayerTimesAdapter): Promise<boolean> {
  try {
    return await adapter.healthCheck();
  } catch {
    return false;
  }
}

async function pickAdapter(preferred?: string): Promise<PrayerTimesAdapter | null> {
  // If a preferred adapter is specified, probe it first (fast path)
  if (preferred) {
    const target = ALL_ADAPTERS.find(a => a.id === preferred);
    if (target && await probeAdapter(target)) return target;
    // Fall through to probe all if preferred is dead
  }
  // Probe all adapters in parallel, pick highest priority that responds
  const results = await Promise.all(ALL_ADAPTERS.map(async a => ({
    adapter: a,
    ok: await probeAdapter(a),
  })));
  const alive = results.filter(r => r.ok).sort((a, b) => b.adapter.priority - a.adapter.priority);
  return alive[0]?.adapter ?? null;
}

async function resolveConfigToCityId(
  config: Config,
  adapter: PrayerTimesAdapter,
): Promise<string | null> {
  // If config was created with this adapter, cityId should be valid
  // But if switching adapters, try to re-resolve
  if (config.adapter === adapter.id && config.cityId) return config.cityId;

  // Try re-resolving: search by city name (with fallback)
  const results = await searchCityWithFallback(adapter, config.cityName, config.country);
  if (results.length > 0) return results[0].id;

  // If adapter supports coords and we have lat/lon, try that
  if (adapter.getTimingsByCoords && config.lat !== undefined && config.lon !== undefined) {
    // Can't easily convert coords → cityId, but we can still use coords for fetching
    return `coords:${config.lat},${config.lon}`;
  }

  return null;
}

/** Direction words that ip-api.com uses but myquran doesn't know */
const DIRECTION_WORDS = /\b(south|north|east|west|central|kota|kabupaten|kab)\b/gi;

/** Search city with fallback: strip English direction words if exact match fails */
async function searchCityWithFallback(
  adapter: PrayerTimesAdapter,
  cityName: string,
  country?: string,
): Promise<CityResult[]> {
  // 1. Exact match
  let results = await adapter.searchCity(cityName, country);
  if (results.length > 0) return results;

  // 2. Strip direction words ("South Tangerang" → "Tangerang")
  const stripped = cityName.replace(DIRECTION_WORDS, "").trim();
  if (stripped && stripped !== cityName) {
    results = await adapter.searchCity(stripped, country);
    if (results.length > 0) return results;
  }

  // 3. Try last word ("Tangerang Selatan" → try "Selatan" if English, but this is Indonesian)
  // Actually, for English→Indonesian mismatch, try each word individually
  const words = cityName.split(/\s+/).filter(w => w.length > 2 && !DIRECTION_WORDS.test(w));
  for (const word of words) {
    if (word === stripped) continue; // already tried
    results = await adapter.searchCity(word, country);
    if (results.length > 0) return results;
  }

  return [];
}

/** Pick one city from search results — auto-confirm if single, select menu if multiple */
async function pickCityFromResults(
  ctx: ExtensionContext,
  results: CityResult[],
  label: string,
): Promise<CityResult | null> {
  if (results.length === 1) {
    const r = results[0];
    const ok = await ctx.ui.confirm(label, `${r.name}${r.region ? `, ${r.region}` : ""} — use this?`);
    return ok ? r : null;
  }
  const choice = await ctx.ui.select(
    `${label}:`,
    results.slice(0, 10).map(r => `${r.name}${r.region ? ` (${r.region})` : ""}`),
  );
  if (!choice) return null;
  const idx = results.slice(0, 10).findIndex(
    r => `${r.name}${r.region ? ` (${r.region})` : ""}` === choice,
  );
  return idx >= 0 ? results[idx] : null;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("adzan-path", { type: "string" as const, description: "Path to adzan.mp3 (default: bundled)" });
  pi.registerFlag("prayer-window", { type: "number" as const, default: 15, description: "Minutes to show 'prayer time'" });

  // ── State ──
  let activeAdapter: PrayerTimesAdapter | null = null;
  let timings: Record<string, string> | null = null;
  let cacheDate: string | null = null;
  let error: string | null = null;
  let staleWarning = false;
  let adzanPlayedToday: string[] = [];
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentCtx: ExtensionContext | null = null;
  let initialized = false;

  // ── Widget ──
  function clearWidget() { currentCtx?.ui.setWidget("prayer-times", undefined); }

  function renderWidget() {
    const ctx = currentCtx;
    if (!ctx?.hasUI || !initialized) return;
    const prayerText = buildWidgetText();
    if (prayerText === null) return;
    const locLabel = getLocationLabel();
    ctx.ui.setWidget("prayer-times", (_tui, theme) => ({
      render(width: number) {
        const labelW = locLabel ? visibleWidth(locLabel) : 0;
        const textW = visibleWidth(prayerText);
        if (locLabel) {
          const gap = Math.max(1, width - labelW - textW);
          const line = locLabel + " ".repeat(gap) + prayerText;
          return [truncateToWidth(theme.fg("warning", line), width)];
        }
        const pad = Math.max(0, width - textW);
        const line = " ".repeat(pad) + prayerText;
        return [truncateToWidth(theme.fg("warning", line), width)];
      },
      invalidate() {},
    }), { placement: "belowEditor" });
  }

  function getLocationLabel(): string {
    const cfg = getConfig();
    if (!cfg) return "";
    const parts = [cfg.cityName];
    if (cfg.country && activeAdapter?.capabilities.global) parts.push(cfg.country);
    return parts.join(", ");
  }

  function buildWidgetText(): string | null {
    const now = new Date();
    if (error && !timings) return `⚠ ${error}`;
    if (!timings) return "⏳ Fetching prayer times...";
    const pw = inPrayerWindow(timings, pi.getFlag("prayer-window") as number, now);
    if (pw) {
      if (!adzanPlayedToday.includes(pw) && tryAcquireAdzanLock(pw)) {
        playAdzan(getAdzanPath(pi));
        markAdzanPlayed(pw);
      }
      return `${pw} prayer time...${staleWarning ? " (⚠ stale)" : ""}`;
    }
    const next = findNext(timings, now);
    if (!next) return "⚠ No upcoming prayer";
    return `${formatCountdown(msUntil(next.time, now))} to ${next.name}..${staleWarning ? " (⚠ stale)" : ""}`;
  }

  function startWidget() {
    if (interval) clearInterval(interval);
    renderWidget();
    interval = setInterval(() => { checkMidnightRefresh(); renderWidget(); }, UPDATE_INTERVAL_MS);
  }

  function stopWidget() { if (interval) { clearInterval(interval); interval = null; } clearWidget(); }

  // ── Data ──
  async function loadData(cfg: Config, forceRefresh = false) {
    error = null; staleWarning = false;

    // Pick adapter (probe if needed)
    const adapter = await pickAdapter(cfg.adapter);
    if (!adapter) {
      error = "No prayer times API reachable";
      return;
    }
    activeAdapter = adapter;

    // Resolve city ID (re-resolve if switching adapters)
    const cityId = await resolveConfigToCityId(cfg, adapter);
    if (!cityId) {
      error = `Cannot resolve "${cfg.cityName}" with ${adapter.name}`;
      return;
    }

    // Save migrated config if adapter/city changed (skip coords: pseudo-id)
    if (!cityId.startsWith("coords:") && (cfg.adapter !== adapter.id || cfg.cityId !== cityId)) {
      cfg.adapter = adapter.id;
      cfg.cityId = cityId;
      setConfig(cfg);
    }

    // Fetch helper: use coords path if cityId is a coords pseudo-id
    async function fetchFresh(): Promise<Record<string, string>> {
      if (cityId.startsWith("coords:")) {
        const [lat, lon] = cityId.slice(7).split(",").map(Number);
        const result = await adapter.getTimingsByCoords!(lat, lon, new Date());
        if (!result) throw new Error("Coords fetch returned null");
        return result;
      }
      return adapter.getTimings(cityId, new Date());
    }

    // Try cache
    const cache = forceRefresh ? null : loadCache();
    const status = cacheStatus(cache);
    if (status === "valid" && cache) {
      timings = cache.timings; cacheDate = cache.date; adzanPlayedToday = cache.adzanPlayed ?? []; return;
    }
    if (status === "stale" && cache) {
      timings = cache.timings; cacheDate = cache.date; adzanPlayedToday = cache.adzanPlayed ?? []; staleWarning = true;
      try {
        const fresh = await fetchFresh();
        timings = fresh; staleWarning = false; cacheDate = todayStr(); adzanPlayedToday = [];
        saveCache({ date: todayStr(), timings: fresh, fetchedAt: Date.now(), adzanPlayed: [] });
      } catch { /* keep stale */ }
      return;
    }
    // No valid cache — must fetch fresh
    try {
      const fresh = await fetchFresh();
      timings = fresh; cacheDate = todayStr(); adzanPlayedToday = [];
      saveCache({ date: todayStr(), timings: fresh, fetchedAt: Date.now(), adzanPlayed: [] });
    } catch (err: any) {
      error = err.name === "AbortError" ? "Request timed out" : "Cannot fetch prayer times";
    }
  }

  function checkMidnightRefresh() {
    if (midnightPassedSince(cacheDate)) {
      const cfg = getConfig();
      if (cfg) loadData(cfg).then(renderWidget);
    }
  }

  function markAdzanPlayed(prayer: PrayerName) {
    if (adzanPlayedToday.includes(prayer)) return;
    adzanPlayedToday.push(prayer);
    const c = loadCache(); if (c) { c.adzanPlayed = adzanPlayedToday; saveCache(c); }
  }

  // ── Location Prompting ──────────────────────────────────────────────────────

  async function promptLocationManual(ctx: ExtensionContext): Promise<Config | null> {
    // Use active adapter if already resolved, otherwise probe
    const adapter = activeAdapter ?? await pickAdapter();
    if (!adapter) {
      ctx.ui.notify("No prayer times API reachable. Check your internet.", "error");
      return null;
    }

    if (adapter.capabilities.global) {
      // Global adapter (aladhan): prompt for city + country
      const ex = getConfig();
      const ci = await ctx.ui.input(`Country [${ex?.country || "Indonesia"} — enter to accept]:`);
      if (ci === undefined || ci === null) return null;
      const country = ci.trim() || ex?.country || "Indonesia";
      const cii = await ctx.ui.input(`City [${ex?.cityName || "Jakarta"} — enter to accept]:`);
      if (cii === undefined || cii === null) return null;
      const city = cii.trim() || ex?.cityName || "Jakarta";
      const ok = await ctx.ui.confirm("Confirm", `${city}, ${country} — correct?`);
      if (!ok) { ctx.ui.notify("Cancelled.", "warning"); return null; }
      const results = await adapter.searchCity(city, country);
      if (results.length === 0) {
        ctx.ui.notify(`City "${city}" not found with ${adapter.name}.`, "error");
        return null;
      }
      const r = await pickCityFromResults(ctx, results, "Confirm");
      if (!r) return null;
      return { adapter: adapter.id, cityId: r.id, cityName: r.name, country: r.country ?? country, lat: r.lat, lon: r.lon };
    } else {
      // Indonesia-only adapter (myquran): search by city name
      const ci = await ctx.ui.input("City name (e.g. Jakarta, Tangerang Selatan):");
      if (!ci?.trim()) return null;
      ctx.ui.notify(`Searching "${ci.trim()}"...`, "info");
      const results = await adapter.searchCity(ci.trim());
      if (results.length === 0) {
        ctx.ui.notify(`No city found matching "${ci.trim()}".`, "error");
        return null;
      }
      const r = await pickCityFromResults(ctx, results, "Found");
      if (!r) return null;
      return { adapter: adapter.id, cityId: r.id, cityName: r.name, country: r.country };
    }
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  pi.registerCommand("prayer-times:init", {
    description: "Set up prayer times",
    handler: async (_a, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("Requires interactive mode", "error");

      // Probe adapters
      const adapter = await pickAdapter();
      if (!adapter) {
        ctx.ui.notify("No prayer times API reachable. Check your internet.", "error");
        return;
      }
      activeAdapter = adapter;

      const mode = await ctx.ui.select("Setup mode", ["Auto-detect (via IP)", "Enter manually"]);
      if (!mode) return;

      let cfg: Config | null = null;

      if (mode === "Auto-detect (via IP)") {
        ctx.ui.notify("Detecting location...", "info");
        const ipLoc = await detectLocation();
        if (!ipLoc) { ctx.ui.notify("IP detection failed. Try manual entry.", "error"); return; }

        if (adapter.capabilities.global) {
          // Global adapter: use IP city+country directly
          const results = await searchCityWithFallback(adapter, ipLoc.city, ipLoc.country);
          if (results.length === 0) {
            ctx.ui.notify(`Cannot resolve "${ipLoc.city}, ${ipLoc.country}". Try manual.`, "error");
            return;
          }
          const r = await pickCityFromResults(ctx, results, "Detected");
          if (!r) return;
          cfg = { adapter: adapter.id, cityId: r.id, cityName: r.name, country: r.country, lat: ipLoc.lat, lon: ipLoc.lon };
        } else {
          // Indonesia-only adapter: search by detected city name
          ctx.ui.notify(`Detected: ${ipLoc.city}. Searching ${adapter.name}...`, "info");
          const results = await searchCityWithFallback(adapter, ipLoc.city);
          if (results.length === 0) {
            ctx.ui.notify(`IP says "${ipLoc.city}" but not found in ${adapter.name}. Try manual.`, "error");
            return;
          }
          const r = await pickCityFromResults(ctx, results, "Detected");
          if (!r) return;
          cfg = { adapter: adapter.id, cityId: r.id, cityName: r.name, country: r.country };
        }
      } else {
        cfg = await promptLocationManual(ctx);
        if (!cfg) return;
      }

      setConfig(cfg);
      initialized = true;
      await loadData(cfg);
      startWidget();
      ctx.ui.notify(`Ready — ${cfg.cityName} via ${adapter.name}`, "success");
    },
  });

  pi.registerCommand("prayer-times:manual-update-location", {
    description: "Update location manually",
    handler: async (_a, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("Requires interactive mode", "error");
      const cfg = await promptLocationManual(ctx);
      if (!cfg) return;
      setConfig(cfg);
      await loadData(cfg, true);
      renderWidget();
      ctx.ui.notify(`Updated: ${cfg.cityName} via ${activeAdapter?.name ?? "?"}`, "success");
    },
  });

  pi.registerCommand("prayer-times:auto-update-location", {
    description: "Auto-detect location via IP",
    handler: async (_a, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("Requires interactive mode", "error");
      const adapter = activeAdapter ?? await pickAdapter();
      if (!adapter) {
        ctx.ui.notify("No prayer times API reachable.", "error");
        return;
      }
      activeAdapter = adapter;

      ctx.ui.notify("Detecting...", "info");
      const ipLoc = await detectLocation();
      if (!ipLoc) { ctx.ui.notify("Detection failed.", "error"); return; }

      let cfg: Config;
      if (adapter.capabilities.global) {
        const results = await searchCityWithFallback(adapter, ipLoc.city, ipLoc.country);
        if (results.length === 0) {
          ctx.ui.notify(`Cannot resolve "${ipLoc.city}, ${ipLoc.country}". Try manual.`, "error");
          return;
        }
        const r = await pickCityFromResults(ctx, results, "Detected");
        if (!r) return;
        cfg = { adapter: adapter.id, cityId: r.id, cityName: r.name, country: r.country, lat: ipLoc.lat, lon: ipLoc.lon };
      } else {
        const results = await searchCityWithFallback(adapter, ipLoc.city);
        if (results.length === 0) {
          ctx.ui.notify(`IP says "${ipLoc.city}" but not found. Try manual.`, "error");
          return;
        }
        const r = await pickCityFromResults(ctx, results, "Detected");
        if (!r) return;
        cfg = { adapter: adapter.id, cityId: r.id, cityName: r.name, country: r.country };
      }

      setConfig(cfg);
      initialized = true;
      await loadData(cfg);
      startWidget();
      ctx.ui.notify(`Updated: ${cfg.cityName} via ${adapter.name}`, "success");
    },
  });

  pi.registerCommand("prayer-times:stop", {
    description: "Stop prayer times, clear all data",
    handler: async (_a, ctx) => {
      stopWidget();
      initialized = false; timings = null; cacheDate = null; error = null; staleWarning = false;
      adzanPlayedToday = []; activeAdapter = null;
      try { fs.unlinkSync(CACHE_PATH); } catch {}
      try { fs.unlinkSync(CONFIG_PATH); } catch {}
      invalidateConfig();
      try { fs.unlinkSync(ADZAN_LOCK_PATH); } catch {}
      ctx.ui.notify("Stopped. Run /prayer-times:init to restart.", "info");
    },
  });

  pi.registerCommand("prayer-times:show", {
    description: "Show today's prayer times",
    handler: async (_a, ctx) => {
      if (!timings) { ctx.ui.notify("Run /prayer-times:init first.", "warning"); return; }
      const cfg = getConfig();
      const hdr = cfg ? `${cfg.cityName}${cfg.country ? `, ${cfg.country}` : ""} (via ${activeAdapter?.name ?? "?"})` : "Unknown";
      const iw = inPrayerWindow(timings, pi.getFlag("prayer-window") as number, new Date());
      const lines = PRAYER_NAMES.map(n => `${n.padEnd(8)} ${timings![n] ?? "??:??"}${iw === n ? " ← now" : ""}`);
      ctx.ui.notify([hdr, "─".repeat(Math.min(hdr.length, 50)), ...lines].join("\n"), "info");
    },
  });

  // ── Events ──────────────────────────────────────────────────────────────────

  pi.on("session_start", (_e, ctx) => {
    currentCtx = ctx;
    if (!ctx.hasUI) return;
    const cfg = getConfig();
    if (cfg) {
      initialized = true;
      startWidget(); // show "⏳ Fetching..." immediately
      loadData(cfg).then(renderWidget); // fire-and-forget: load in background
    }
  });

  pi.on("session_shutdown", () => { stopWidget(); currentCtx = null; });
}
