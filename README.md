# pi-prayer-times

Islamic prayer time reminders for [pi coding agent](https://github.com/badlogic/pi-mono). Shows a live countdown to the next prayer below the editor, plays adzan when prayer time arrives, and auto-detects your location via IP.

<p align="center">
  <i>Jakarta, Indonesia &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 03h 45m to Asr..</i>
</p>

## Features

- **Live countdown** — yellow widget below the editor showing time until next prayer
- **Adzan playback** — plays bundled `adzan.mp3` when prayer time arrives (15-min window)
- **Auto-detect location** — IP geolocation (lat/lon) for accurate timings, or manual entry
- **Country-aware calculation** — auto-selects the correct calculation method (Kemenag for Indonesia, ISNA for US, etc.)
- **Smart caching** — caches daily, survives restarts, auto-refreshes at midnight
- **Multi-instance safe** — atomic lock prevents 6 pi tabs from playing 6 overlapping adzans
- **Typo protection** — confirms city/country before saving

## Install

```bash
pi install git:github.com/yourusername/pi-prayer-times
```

Or clone manually:

```bash
git clone https://github.com/yourusername/pi-prayer-times ~/.pi/agent/extensions/pi-prayer-times
```

Restart pi — the extension auto-loads.

## Quick Start

Run `/prayer-times:init` and choose:

- **Auto-detect (via IP)** — detects your city/country/lat/lon automatically
- **Enter manually** — type country and city (defaults: Indonesia / Jakarta)

After setup, the widget appears below the editor and stays there.

## Commands

| Command | Description |
|---------|-------------|
| `/prayer-times:init` | First-run setup — auto-detect or manual |
| `/prayer-times:show` | Show today's 5 prayer times with `← now` marker |
| `/prayer-times:auto-update-location` | Re-detect location via IP |
| `/prayer-times:manual-update-location` | Re-enter city/country manually |
| `/prayer-times:stop` | Stop widget, clear cache & config |

## Flags

All optional — set in `~/.pi/agent/settings.json` or via CLI:

```
--prayer-city <city>          City (overrides saved config)
--prayer-country <country>    Country (overrides saved config)
--prayer-method <number>      Calculation method override (auto-detected by country)
--prayer-window <minutes>     Minutes to show "prayer time" after adzan (default: 15)
--adzan-path <path>           Custom adzan.mp3 (default: bundled)
```

Example:

```bash
pi --prayer-city "Surabaya" --prayer-country "Indonesia"
```

Or persist in `~/.pi/agent/settings.json`:

```json
{
  "flags": {
    "prayer-city": "Surabaya",
    "prayer-country": "Indonesia"
  }
}
```

## Country → Calculation Method

The extension auto-detects the correct method based on your country:

| Country | Method |
|---------|--------|
| Indonesia | 20 (Kemenag RI) |
| Malaysia, Brunei | 17 (JAKIM) |
| Singapore | 11 (MUIS) |
| Saudi Arabia, UAE, Qatar, Kuwait, Bahrain, Oman | 4 (Umm Al-Qura) |
| USA, Canada | 2 (ISNA) |
| UK | 15 (London Unified) |
| France | 12 (UOIF) |
| Turkey | 13 (Diyanet) |
| Egypt | 5 (Egyptian General) |
| Pakistan, India, Bangladesh | 1 (Karachi) |
| Iran | 7 (Tehran) |
| Other | 3 (Muslim World League) |

Override with `--prayer-method`.

## How It Works

1. **Location** — IP geolocation (`ip-api.com`) or manual entry → saved to `~/.pi/prayer-times-config.json`
2. **Prayer times** — fetched from [Aladhan API](https://aladhan.com) (coordinates when available, city-name fallback)
3. **Cache** — stored in `~/.pi/prayer-times-cache.json`, valid 1 day, stale up to 2 days
4. **Widget** — updates every 30 seconds, shows countdown or "prayer time" status
5. **Adzan** — atomic file lock ensures only one pi instance plays per prayer
6. **Midnight** — auto-refreshes prayer times at midnight

## Custom Adzan

Replace the bundled `adzan.mp3`:

```bash
pi --adzan-path ~/Music/my-adzan.mp3
```

Or replace the file in the extension directory.

## License

MIT
