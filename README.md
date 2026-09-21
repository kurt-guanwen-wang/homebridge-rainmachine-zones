# homebridge-rainmachine-zones

[![npm](https://img.shields.io/npm/v/homebridge-rainmachine-zones.svg)](https://www.npmjs.com/package/homebridge-rainmachine-zones)

A [Homebridge](https://homebridge.io) dynamic platform plugin that exposes
your [RainMachine](https://rainmachine.com) sprinkler zones to Apple
HomeKit as `Valve` (irrigation) accessories.

RainMachine advertises built-in HomeKit support, but for many users it
simply doesn't work. This plugin bypasses that entirely by talking directly
to the RainMachine's **local HTTPS API** - no cloud dependency, and
**zero npm dependencies** (it only uses Node's built-in `https`/`url`
modules).

## Features

- Exposes each RainMachine zone as a HomeKit `Valve` (irrigation) accessory
  - start/stop watering, see remaining duration, and set a run time from the
    Home app.
- Only exposes **active** zones by default (zones disabled on the
  controller are hidden) - configurable.
- Fully configurable from the Homebridge UI - no manual `config.json`
  editing or environment variables required.
- Detects and logs zones started/stopped **outside** of HomeKit (e.g. via
  the RainMachine app, its web UI, or the controller's own schedule).
- Clear, actionable logging for common problems (wrong password,
  unreachable host, bad address, etc.) - see [Troubleshooting](#troubleshooting).

## Installation

Search for "RainMachine" in the Homebridge UI's Plugins tab, or install
manually:

```bash
npm install -g homebridge-rainmachine-zones
```

## Configuration

Configure entirely through the Homebridge UI (recommended) - go to the
plugin's settings page and fill in:

| Setting | Required | Default | Description |
|---|---|---|---|
| Name | no | `RainMachine` | Display name for the platform. |
| RainMachine Address | **yes** | - | Your RainMachine's local address. Accepts a bare hostname/IP (`rainmachine.local`), `host:port`, or a full URL (`https://rainmachine.local:8080/api/4`). Missing scheme/port/path are filled in automatically. |
| Password | **yes** | - | Your RainMachine's local access password (same one used to log into its local web UI). |
| Ignore inactive zones | no | `true` (checked) | When checked, zones disabled on the controller are not exposed to HomeKit at all. |
| Poll Interval (seconds) | no (advanced) | `30` (min `10`) | How often the plugin refreshes zone state from the controller - also how quickly externally-triggered changes (RainMachine app/schedule) are picked up. |
| Default Run Time (seconds) | no (advanced) | `600` (min `30`) | Duration used when a zone is started from the Home app without an explicit duration. |

Or configure directly in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "RainMachineZones",
      "name": "RainMachine",
      "address": "https://rainmachine.local:8080/api/4",
      "password": "your-rainmachine-password",
      "ignoreInactiveZones": true,
      "pollInterval": 30,
      "defaultRunTime": 600
    }
  ]
}
```

## How it works

- Logs in via RainMachine's local `/auth/login` endpoint and caches the
  access token, refreshing it before it expires or on a `401`.
- Fetches `/zone` on startup and on every poll interval, registering,
  updating, or removing HomeKit accessories to match the controller's
  current zones.
- Zone start/stop from HomeKit calls `/zone/{id}/start` / `/zone/{id}/stop`.
- Self-signed certificates (as used by RainMachine) are accepted
  automatically.

## Troubleshooting

The plugin logs clear, actionable messages for common problems. Look for
these in your Homebridge log:

| Symptom | Log message | Likely cause |
|---|---|---|
| Plugin does nothing | `No RainMachine address configured` / `No RainMachine password configured` | A required setting is blank - fill it in via the Homebridge UI. |
| Zones never appear | `cannot resolve host in "..."` | DNS/hostname typo, or Homebridge can't resolve that name. |
| | `connection refused by "..."` | Wrong port, or the RainMachine is unreachable from Homebridge's network. |
| | `... timed out` | Network path exists but the RainMachine isn't responding - check firewall/VLAN rules. |
| Connects but immediately errors | `authentication rejected (HTTP 401) - check the configured RainMachine password` | Wrong password. |
| Confirming what was found | `Discovered N zone(s): <name> (idle/running), ...` | Informational - lists every zone currently exposed. |
| A zone ran outside HomeKit | `Started/Stopped zone "X" externally (detected on poll, ...)` | Expected - reflects watering triggered by the RainMachine app, web UI, or its own schedule. |

Enable Homebridge's debug mode for verbose per-request tracing.

## License

[MIT](./LICENSE)
