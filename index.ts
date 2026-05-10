/**
 * Prayer Times Extension for pi coding agent.
 *
 * See README.md for full documentation.
 * Pure logic functions are in lib.ts (testable).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
  getMethod,
  cacheStatus,
  midnightPassedSince,
  findNext,
  inPrayerWindow,
} from "./lib";

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(os.homedir(), ".pi", "prayer-times-cache.json");
const CONFIG_PATH = path.join(os.homedir(), ".pi", "prayer-times-config.json");
const ADZAN_LOCK_PATH = path.join(os.homedir(), ".pi", "prayer-times-adzan.lock");
const UPDATE_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
interface Config {
  country: string;
  city: string;
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

function loadConfig(): Config | null {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { return null; }
}
function saveConfig(config: Config): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function getLocation(pi: ExtensionAPI): Config | null {
  const fc = pi.getFlag("prayer-city") as string | undefined;
  const fco = pi.getFlag("prayer-country") as string | undefined;
  if (fc && fco) return { city: fc, country: fco };
  const c = loadConfig();
  if (c?.city && c?.country) return c;
  return null;
}

// ── API ──────────────────────────────────────────────────────────────────────

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

async function fetchTimingsUrl(url: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const s = signal ? anySignal([signal, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(url, { signal: s });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 200) throw new Error(json.status ?? "API error");
    const timings: Record<string, string> = {};
    for (const name of PRAYER_NAMES) {
      if (json.data.timings[name]) timings[name] = json.data.timings[name];
    }
    return timings;
  } finally { clearTimeout(t); }
}

function fetchByCity(city: string, country: string, method: number, signal?: AbortSignal) {
  return fetchTimingsUrl(
    `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${method}`,
    signal,
  );
}

function fetchByCoords(lat: number, lon: number, method: number, signal?: AbortSignal) {
  return fetchTimingsUrl(
    `https://api.aladhan.com/v1/timings?latitude=${lat}&longitude=${lon}&method=${method}`,
    signal,
  );
}

function fetchPrayerTimings(loc: Config, method: number, signal?: AbortSignal) {
  if (loc.lat !== undefined && loc.lon !== undefined) return fetchByCoords(loc.lat, loc.lon, method, signal);
  return fetchByCity(loc.city, loc.country, method, signal);
}

// ── IP Geolocation ──────────────────────────────────────────────────────────

async function detectLocation(): Promise<Config | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch("http://ip-api.com/json", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "success" || !data.city || !data.country) return null;
    return { city: data.city, country: data.country, lat: data.lat, lon: data.lon };
  } catch { return null; }
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

/** Atomic lock: only one pi instance plays adzan per prayer per day */
function tryAcquireAdzanLock(prayer: string): boolean {
  const date = todayStr();
  try {
    fs.mkdirSync(path.dirname(ADZAN_LOCK_PATH), { recursive: true });
    fs.writeFileSync(ADZAN_LOCK_PATH, JSON.stringify({ prayer, date, ts: Date.now() }), { flag: "wx" });
    return true;
  } catch (err: any) {
    if (err.code !== "EEXIST") return true;
    try {
      const lock = JSON.parse(fs.readFileSync(ADZAN_LOCK_PATH, "utf-8"));
      // Same prayer on same day → already played by another instance
      if (lock.prayer === prayer && lock.date === date) return false;
      // Different prayer or new day → take over the lock
      fs.unlinkSync(ADZAN_LOCK_PATH);
      fs.writeFileSync(ADZAN_LOCK_PATH, JSON.stringify({ prayer, date, ts: Date.now() }), { flag: "wx" });
      return true;
    } catch { return true; }
  }
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("prayer-city", { type: "string" as const, description: "City (overrides saved config)" });
  pi.registerFlag("prayer-country", { type: "string" as const, description: "Country (overrides saved config)" });
  pi.registerFlag("prayer-method", { type: "number" as const, description: "Method override (auto-detected by country)" });
  pi.registerFlag("adzan-path", { type: "string" as const, description: "Path to adzan.mp3 (default: bundled)" });
  pi.registerFlag("prayer-window", { type: "number" as const, default: 15, description: "Minutes to show 'prayer time'" });

  // ── State ──
  let timings: Record<string, string> | null = null;
  let cacheDate: string | null = null;
  let error: string | null = null;
  let staleWarning = false;
  let adzanPlayedToday: string[] = [];
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentCtx: import("@mariozechner/pi-coding-agent").ExtensionContext | null = null;
  let initialized = false;

  // ── Widget ──
  function clearWidget() { currentCtx?.ui.setWidget("prayer-times", undefined); }

  function renderWidget() {
    const ctx = currentCtx;
    if (!ctx?.hasUI || !initialized) return;
    const prayerText = buildWidgetText();
    if (prayerText === null) return;
    const loc = getLocation(pi);
    const locationText = loc ? `${loc.city}, ${loc.country}` : "";
    ctx.ui.setWidget("prayer-times", (_tui, theme) => ({
      render(width: number) {
        if (locationText) {
          const gap = " ".repeat(Math.max(1, width - locationText.length - prayerText.length));
          return [theme.fg("warning", locationText + gap + prayerText)];
        }
        return [theme.fg("warning", " ".repeat(Math.max(0, width - prayerText.length)) + prayerText)];
      },
      invalidate() {},
    }), { placement: "belowEditor" });
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
  async function loadData(loc: Config, forceRefresh = false) {
    error = null; staleWarning = false;
    const method = getMethod(loc.country, pi.getFlag("prayer-method") as number | undefined);
    const cache = forceRefresh ? null : loadCache();
    const status = cacheStatus(cache);
    if (status === "valid" && cache) {
      timings = cache.timings; cacheDate = cache.date; adzanPlayedToday = cache.adzanPlayed ?? []; return;
    }
    if (status === "stale" && cache) {
      timings = cache.timings; cacheDate = cache.date; adzanPlayedToday = cache.adzanPlayed ?? []; staleWarning = true;
      try {
        const fresh = await fetchPrayerTimings(loc, method);
        timings = fresh; staleWarning = false; cacheDate = todayStr(); adzanPlayedToday = [];
        saveCache({ date: todayStr(), timings: fresh, fetchedAt: Date.now(), adzanPlayed: [] });
      } catch { /* keep stale */ }
      return;
    }
    try {
      const fresh = await fetchPrayerTimings(loc, method);
      timings = fresh; cacheDate = todayStr(); adzanPlayedToday = [];
      saveCache({ date: todayStr(), timings: fresh, fetchedAt: Date.now(), adzanPlayed: [] });
    } catch (err: any) {
      error = err.name === "AbortError" ? "Request timed out" : "Cannot fetch prayer times";
    }
  }

  function checkMidnightRefresh() {
    if (midnightPassedSince(cacheDate)) { const l = getLocation(pi); if (l) loadData(l).then(renderWidget); }
  }

  function markAdzanPlayed(prayer: PrayerName) {
    if (adzanPlayedToday.includes(prayer)) return;
    adzanPlayedToday.push(prayer);
    const c = loadCache(); if (c) { c.adzanPlayed = adzanPlayedToday; saveCache(c); }
  }

  // ── Prompt ──
  async function promptLocation(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext): Promise<Config | null> {
    const fc = pi.getFlag("prayer-city") as string | undefined;
    const fco = pi.getFlag("prayer-country") as string | undefined;
    if (fc && fco) { ctx.ui.notify(`Using flags: ${fc}, ${fco}`, "info"); return { city: fc, country: fco }; }
    const ex = loadConfig();
    const ci = await ctx.ui.input(`Country [${ex?.country || "Indonesia"} — enter to accept]:`);
    if (ci === undefined || ci === null) return null;
    const country = ci.trim() || ex?.country || "Indonesia";
    const cii = await ctx.ui.input(`City [${ex?.city || "Jakarta"} — enter to accept]:`);
    if (cii === undefined || cii === null) return null;
    const city = cii.trim() || ex?.city || "Jakarta";
    const ok = await ctx.ui.confirm("Confirm", `${city}, ${country} — correct?`);
    if (!ok) { ctx.ui.notify("Cancelled.", "warning"); return null; }
    const cfg: Config = { country, city }; saveConfig(cfg); return cfg;
  }

  // ── Events ──
  pi.on("session_start", async (_e, ctx) => {
    currentCtx = ctx;
    if (!ctx.hasUI) return;
    const l = getLocation(pi);
    if (l) { initialized = true; await loadData(l); startWidget(); }
  });
  pi.on("session_shutdown", () => { stopWidget(); currentCtx = null; });

  // ── Commands ──
  pi.registerCommand("prayer-times:init", {
    description: "Set up prayer times",
    handler: async (_a, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("Requires interactive mode", "error");
      const m = await ctx.ui.select("How?", ["Auto-detect (via IP)", "Enter manually"]);
      if (!m) return;
      let loc: Config | null = null;
      if (m === "Auto-detect (via IP)") {
        ctx.ui.notify("Detecting...", "info");
        const d = await detectLocation();
        if (!d) { ctx.ui.notify("Detection failed.", "error"); return; }
        if (!await ctx.ui.confirm("Detected", `${d.city}, ${d.country} — save?`)) { ctx.ui.notify("Cancelled.", "warning"); return; }
        loc = d;
      } else {
        loc = await promptLocation(ctx);
        if (!loc) return;
      }
      saveConfig(loc); initialized = true; await loadData(loc); startWidget();
      ctx.ui.notify(`Initialized: ${loc.city}, ${loc.country}`, "success");
    },
  });

  pi.registerCommand("prayer-times:manual-update-location", {
    description: "Update location manually",
    handler: async (_a, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("Requires interactive mode", "error");
      const l = await promptLocation(ctx); if (!l) return;
      await loadData(l, true); renderWidget();
      ctx.ui.notify(`Updated: ${l.city}, ${l.country}`, "success");
    },
  });

  pi.registerCommand("prayer-times:auto-update-location", {
    description: "Auto-detect location via IP",
    handler: async (_a, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("Requires interactive mode", "error");
      ctx.ui.notify("Detecting...", "info");
      const d = await detectLocation();
      if (!d) { ctx.ui.notify("Detection failed.", "error"); return; }
      if (!await ctx.ui.confirm("Detected", `${d.city}, ${d.country} — save?`)) { ctx.ui.notify("Cancelled.", "warning"); return; }
      saveConfig(d); initialized = true; await loadData(d); startWidget();
      ctx.ui.notify(`Initialized: ${d.city}, ${d.country}`, "success");
    },
  });

  pi.registerCommand("prayer-times:stop", {
    description: "Stop prayer times, clear all data",
    handler: async (_a, ctx) => {
      stopWidget();
      initialized = false; timings = null; cacheDate = null; error = null; staleWarning = false; adzanPlayedToday = [];
      try { fs.unlinkSync(CACHE_PATH); } catch {}
      try { fs.unlinkSync(CONFIG_PATH); } catch {}
      try { fs.unlinkSync(ADZAN_LOCK_PATH); } catch {}
      ctx.ui.notify("Stopped. Run /prayer-times:init to restart.", "info");
    },
  });

  pi.registerCommand("prayer-times:show", {
    description: "Show today's prayer times",
    handler: async (_a, ctx) => {
      if (!timings) { ctx.ui.notify("Run /prayer-times:init first.", "warning"); return; }
      const loc = getLocation(pi);
      const hdr = loc ? `${loc.city}, ${loc.country}` : "Unknown";
      const iw = inPrayerWindow(timings, pi.getFlag("prayer-window") as number, new Date());
      const lines = PRAYER_NAMES.map(n => `${n.padEnd(8)} ${timings![n] ?? "??:??"}${iw === n ? " ← now" : ""}`);
      ctx.ui.notify([hdr, "─".repeat(hdr.length), ...lines].join("\n"), "info");
    },
  });
}
