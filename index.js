// homebridge-rainmachine-zones
//
// A zero-dependency Homebridge dynamic platform that exposes each RainMachine
// sprinkler zone as a HomeKit Valve (Irrigation) accessory, talking directly
// to the RainMachine's local HTTPS API (no cloud dependency).
//
// Configurable entirely via the Homebridge UI (see config.schema.json), or
// directly in the platforms array in config.json:
//   {
//     "platform": "RainMachineZones",
//     "name": "RainMachine",
//     "address": "https://rainmachine.home.arpa:8080/api/4",
//     "password": "...",
//     "ignoreInactiveZones": true,                              // default true; hide zones disabled on the controller
//     "pollInterval": 30,                                       // seconds between state refreshes
//     "defaultRunTime": 600                                     // default watering duration in seconds
//   }

'use strict';

const https = require('https');
const { URL } = require('url');

const PLUGIN_NAME = 'homebridge-rainmachine-zones';
const PLATFORM_NAME = 'RainMachineZones';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RainMachineZonesPlatform);
};

// Accept a bare hostname/IP, a "host:port" pair, or a full URL, and normalize it
// into a complete "https://host:port/api/4"-style base URL. This tolerates the
// common case of a user typing just the RainMachine's hostname into the UI.
function normalizeBaseUrl(input, log) {
  let raw = (input || '').trim();
  if (!raw) return '';

  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    if (log) log.error('Could not parse RainMachine address "%s": %s', input, err.message);
    return '';
  }

  if (!url.port) {
    url.port = '8080';
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/api/4';
  }

  return url.toString().replace(/\/+$/, '');
}

class RainMachineZonesPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map(); // uuid -> PlatformAccessory
    this.zoneStates = new Map(); // zoneUid -> { running, remaining }

    const rawAddress = this.config.address || this.config.baseUrl || '';
    this.baseUrl = normalizeBaseUrl(rawAddress, this.log);
    this.password = this.config.password || '';

    const rawPollInterval = Number(this.config.pollInterval);
    if (this.config.pollInterval !== undefined && (!Number.isFinite(rawPollInterval) || rawPollInterval < 10)) {
      this.log.warn(
        'Configured pollInterval (%s) is invalid or below the 10s minimum; using %ss instead',
        this.config.pollInterval,
        Math.max(10, rawPollInterval || 30)
      );
    }
    this.pollInterval = Math.max(10, rawPollInterval || 30) * 1000;

    const rawDefaultRunTime = Number(this.config.defaultRunTime);
    if (this.config.defaultRunTime !== undefined && (!Number.isFinite(rawDefaultRunTime) || rawDefaultRunTime < 30)) {
      this.log.warn(
        'Configured defaultRunTime (%s) is invalid or below the 30s minimum; using %ss instead',
        this.config.defaultRunTime,
        Math.max(30, rawDefaultRunTime || 600)
      );
    }
    this.defaultRunTime = Math.max(30, rawDefaultRunTime || 600);

    // Checkbox in the UI defaults to checked (ignore inactive zones), so only an
    // explicit `false` should disable the filter.
    this.ignoreInactiveZones = this.config.ignoreInactiveZones !== false;

    this._token = null;
    this._tokenExpiresAt = 0;

    let configOk = true;
    if (!this.baseUrl) {
      this.log.error(
        'No RainMachine address configured. Open this plugin\'s settings in the Homebridge UI (Plugins tab) and set ' +
          '"RainMachine Address", e.g. "https://rainmachine.home.arpa:8080/api/4" or just "rainmachine.home.arpa". ' +
          'This plugin will not work until this is fixed.'
      );
      configOk = false;
    } else if (rawAddress !== this.baseUrl) {
      this.log.info('Normalized configured address "%s" to "%s"', rawAddress, this.baseUrl);
    }
    if (!this.password) {
      this.log.error(
        'No RainMachine password configured. Open this plugin\'s settings in the Homebridge UI (Plugins tab) and set ' +
          '"RainMachine Password". This plugin will not work until this is fixed.'
      );
      configOk = false;
    }

    if (configOk) {
      this.log.info(
        'Configured: address=%s, ignoreInactiveZones=%s, pollInterval=%ss, defaultRunTime=%ss',
        this.baseUrl,
        this.ignoreInactiveZones,
        this.pollInterval / 1000,
        this.defaultRunTime
      );
    }

    this.api.on('didFinishLaunching', () => {
      if (!configOk) {
        this.log.error('Skipping zone discovery because the plugin is not fully configured (see errors above).');
        return;
      }
      this.log.info('Discovering RainMachine zones...');
      this.discoverZones().catch((err) => this.log.error('Initial zone discovery failed: %s', this.describeError(err)));
      this._pollTimer = setInterval(() => {
        // Re-runs full discovery so zones that become inactive are dropped and
        // zones that become active are picked up, in addition to state refresh.
        this.discoverZones().catch((err) => this.log.warn('Periodic zone refresh failed: %s', this.describeError(err)));
      }, this.pollInterval);
    });

    this.api.on('shutdown', () => {
      if (this._pollTimer) clearInterval(this._pollTimer);
      this.log.info('Shutting down');
    });
  }

  // Turns a raw Error (network failure, HTTP status, JSON parse issue, etc.)
  // into a short, actionable message for the Homebridge log.
  describeError(err) {
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      return `cannot resolve host in "${this.baseUrl}" (${err.code}) - check the RainMachine address is correct and reachable from this network`;
    }
    if (err.code === 'ECONNREFUSED') {
      return `connection refused by "${this.baseUrl}" (${err.code}) - is the RainMachine powered on and is the port correct, e.g. :8080?`;
    }
    if (err.code === 'ETIMEDOUT' || err.message.includes('timed out')) {
      return `request to "${this.baseUrl}" timed out - check the RainMachine is reachable from this pod/network`;
    }
    if (err.statusCode === 401) {
      return `authentication rejected (HTTP 401) - check the configured RainMachine password`;
    }
    if (err.statusCode) {
      return `RainMachine returned HTTP ${err.statusCode}: ${err.message}`;
    }
    return err.message;
  }

  // Called by Homebridge for every cached accessory restored from disk.
  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  uuidForZone(uid) {
    return this.api.hap.uuid.generate(`rainmachine-zone-${uid}`);
  }

  // ---------------------------------------------------------------------
  // RainMachine local API helpers
  // ---------------------------------------------------------------------

  _rawRequest(url, method, bodyStr) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          rejectUnauthorized: false, // RainMachine uses a self-signed certificate
          timeout: 15000,
          headers: bodyStr
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
            : {},
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            let parsed = {};
            try {
              parsed = raw ? JSON.parse(raw) : {};
            } catch (e) {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                this.log.warn('RainMachine returned non-JSON body for %s %s (status %s): %s', method, url.pathname, res.statusCode, e.message);
              }
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(`RainMachine API ${method} ${url.pathname} returned ${res.statusCode}`);
              err.statusCode = res.statusCode;
              reject(err);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`RainMachine API ${method} ${url.pathname} timed out`)));
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async login() {
    const url = new URL(`${this.baseUrl}/auth/login`);
    this.log.debug('Authenticating with RainMachine at %s', url.origin);
    const body = JSON.stringify({ pwd: this.password, remember: 1 });
    let data;
    try {
      data = await this._rawRequest(url, 'POST', body);
    } catch (err) {
      throw new Error(`Login failed: ${this.describeError(err)}`);
    }
    if (!data.access_token) {
      throw new Error('Login failed: RainMachine did not return an access_token (check the configured password)');
    }
    this._token = data.access_token;
    this._tokenExpiresAt = Date.now() + (Number(data.expires_in || 3600) - 30) * 1000;
    this.log.info('Logged in to RainMachine (token valid for %ss)', data.expires_in);
  }

  async apiRequest(method, path, bodyObj) {
    if (!this._token || Date.now() >= this._tokenExpiresAt) {
      await this.login();
    }
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : undefined;
    const buildUrl = () => {
      const url = new URL(`${this.baseUrl}${path}`);
      url.searchParams.set('access_token', this._token);
      return url;
    };
    this.log.debug('%s %s', method, path);
    try {
      return await this._rawRequest(buildUrl(), method, bodyStr);
    } catch (err) {
      if (err.statusCode === 401) {
        this.log.warn('Access token rejected by RainMachine, re-authenticating and retrying %s %s', method, path);
        await this.login();
        return this._rawRequest(buildUrl(), method, bodyStr);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Accessory management
  // ---------------------------------------------------------------------

  // A zone is "active" when it's enabled on the controller (zone.active !== false).
  // This is independent of zone.state, which reflects whether it's currently running.
  isZoneActive(zone) {
    return zone.active !== false;
  }

  async discoverZones() {
    const data = await this.apiRequest('GET', '/zone');
    const allZones = data.zones || [];
    const activeCount = allZones.filter((zone) => this.isZoneActive(zone)).length;
    const zones = allZones.filter((zone) => !this.ignoreInactiveZones || this.isZoneActive(zone));

    this.log.debug(
      'Fetched %s zone(s) from RainMachine (%s active, %s inactive); ignoreInactiveZones=%s -> exposing %s',
      allZones.length,
      activeCount,
      allZones.length - activeCount,
      this.ignoreInactiveZones,
      zones.length
    );

    if (allZones.length === 0) {
      this.log.warn('RainMachine reported zero zones - double check the controller has zones configured');
    }

    const zoneSummary = zones
      .map((zone) => `${zone.name || `Zone ${zone.uid}`} (${zone.state ? `running, ${zone.remaining || 0}s left` : 'idle'})`)
      .join(', ');
    const zoneUuids = zones.map((zone) => this.uuidForZone(zone.uid)).sort().join(',');
    if (zoneUuids !== this._lastDiscoveredZoneUuids) {
      // The set of exposed zones changed since the last poll (first run, or a zone
      // was added/removed/(de)activated on the controller) - log it at info level
      // so it's visible without enabling debug mode.
      this._lastDiscoveredZoneUuids = zoneUuids;
      this.log.info('Discovered %s zone(s): %s', zones.length, zoneSummary || '(none)');
    } else {
      // Unchanged from the previous poll - still log at debug level for troubleshooting.
      this.log.debug('Zones unchanged: %s', zoneSummary || '(none)');
    }

    const seen = new Set();
    for (const zone of zones) {
      seen.add(this.uuidForZone(zone.uid));
      try {
        this.setupZoneAccessory(zone);
      } catch (err) {
        this.log.error('Failed to set up zone "%s" (uid %s): %s', zone.name || zone.uid, zone.uid, err.message);
      }
    }
    // Drop accessories for zones that are now inactive (when ignoreInactiveZones is
    // on) or no longer exist on the controller.
    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        this.zoneStates.delete(accessory.context.zoneId);
        this.log.info('Removed inactive/missing zone "%s" (uid %s)', accessory.displayName, accessory.context.zoneId);
      }
    }
  }

  setupZoneAccessory(zone) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.uuidForZone(zone.uid);
    const displayName = zone.name || `Zone ${zone.uid}`;
    let accessory = this.accessories.get(uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid);
      accessory.context.zoneId = zone.uid;
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Added zone "%s" (uid %s)', displayName, zone.uid);
    }
    accessory.context.zoneId = zone.uid;
    accessory.displayName = displayName;

    const service = accessory.getService(Service.Valve) || accessory.addService(Service.Valve, displayName);
    service.setCharacteristic(Characteristic.Name, displayName);
    service.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
    service.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);

    if (!service.testCharacteristic(Characteristic.SetDuration)) {
      service.addCharacteristic(Characteristic.SetDuration);
    }
    if (service.getCharacteristic(Characteristic.SetDuration).value === 0) {
      service.updateCharacteristic(Characteristic.SetDuration, this.defaultRunTime);
    }
    if (!service.testCharacteristic(Characteristic.RemainingDuration)) {
      service.addCharacteristic(Characteristic.RemainingDuration);
    }

    const running = !!zone.state;
    const previous = this.zoneStates.get(zone.uid);
    if (previous && previous.running !== running) {
      // Picked up on a poll, not via a HomeKit onSet() call, so this was triggered
      // externally (RainMachine app/web UI, schedule, or another integration).
      this.log.info(
        '%s zone "%s" externally (detected on poll, remaining %ss)',
        running ? 'Started' : 'Stopped',
        displayName,
        zone.remaining || 0
      );
    }
    service.updateCharacteristic(Characteristic.Active, running ? 1 : 0);
    service.updateCharacteristic(Characteristic.InUse, running ? 1 : 0);
    service.updateCharacteristic(Characteristic.RemainingDuration, zone.remaining || 0);
    this.zoneStates.set(zone.uid, { running, remaining: zone.remaining || 0 });

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.zoneStates.get(zone.uid)?.running ? 1 : 0))
      .onSet(async (value) => {
        const duration = service.getCharacteristic(Characteristic.SetDuration).value || this.defaultRunTime;
        try {
          if (value) {
            await this.apiRequest('POST', `/zone/${zone.uid}/start`, { time: duration, zid: zone.uid });
            service.updateCharacteristic(Characteristic.InUse, 1);
            service.updateCharacteristic(Characteristic.RemainingDuration, duration);
            this.zoneStates.set(zone.uid, { running: true, remaining: duration });
            this.log.info('Started zone "%s" for %ss', displayName, duration);
          } else {
            await this.apiRequest('POST', `/zone/${zone.uid}/stop`, { zid: zone.uid });
            service.updateCharacteristic(Characteristic.InUse, 0);
            service.updateCharacteristic(Characteristic.RemainingDuration, 0);
            this.zoneStates.set(zone.uid, { running: false, remaining: 0 });
            this.log.info('Stopped zone "%s"', displayName);
          }
        } catch (err) {
          this.log.error('Failed to %s zone "%s": %s', value ? 'start' : 'stop', displayName, err.message);
          throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    service.getCharacteristic(Characteristic.InUse).onGet(() => (this.zoneStates.get(zone.uid)?.running ? 1 : 0));
  }
}
