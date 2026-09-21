'use strict';
const hap = require('hap-nodejs');
const util = require('util');
const { startMockServer } = require('./mockserver');
const registerFn = require('../index.js');

let PlatformCtor;
registerFn({
  hap,
  registerPlatform: (_pluginName, _platformName, ctor) => {
    PlatformCtor = ctor;
  },
});

function makeApi() {
  const listeners = {};
  const registered = [];
  const unregistered = [];
  const api = {
    hap: {
      Service: hap.Service,
      Characteristic: hap.Characteristic,
      uuid: hap.uuid,
      HapStatusError: hap.HapStatusError,
      HAPStatus: hap.HAPStatus,
    },
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    emit(event) {
      (listeners[event] || []).forEach((cb) => cb());
    },
    platformAccessory: class {
      constructor(name, uuid) {
        this.displayName = name;
        this.UUID = uuid;
        this.services = [];
        this.context = {};
      }
      getService(svc) {
        return this.services.find((s) => s.constructor === svc || s.UUID === svc.UUID);
      }
      addService(Svc, name) {
        const s = new Svc(name);
        this.services.push(s);
        return s;
      }
    },
    registerPlatformAccessories(_p, _pl, accs) {
      registered.push(...accs);
    },
    unregisterPlatformAccessories(_p, _pl, accs) {
      unregistered.push(...accs);
    },
    _registered: registered,
    _unregistered: unregistered,
  };
  return api;
}

function makeLogger(tag) {
  const lines = [];
  const wrap = (level) => (...args) => {
    const msg = util.format(...args);
    lines.push(`[${level}] ${msg}`);
    // eslint-disable-next-line no-console
    console.log(`${tag} [${level}] ${msg}`);
  };
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug'), lines };
}

async function run() {
  let pass = 0;
  let fail = 0;
  function check(name, cond) {
    if (cond) {
      pass++;
      console.log(`  OK: ${name}`);
    } else {
      fail++;
      console.log(`  FAIL: ${name}`);
    }
  }

  // Scenario 1: happy path
  {
    console.log('\n=== Scenario 1: happy path ===');
    const server = await startMockServer(9443, {});
    const log = makeLogger('S1');
    const api = makeApi();
    const platform = new PlatformCtor(
      log,
      { platform: 'RainMachineZones', address: 'https://127.0.0.1:9443', password: 'pw' },
      api
    );
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 500));
    check('logged in message present', log.lines.some((l) => l.includes('Logged in to RainMachine')));
    check('configured summary logged', log.lines.some((l) => l.includes('Configured: address=')));
    check('2 active zones registered (inactive filtered)', api._registered.length === 2);
    clearInterval(platform._pollTimer);
    server.close();
  }

  // Scenario 2: wrong password (401 on login)
  {
    console.log('\n=== Scenario 2: wrong password ===');
    const server = await startMockServer(9444, { wrongPassword: true });
    const log = makeLogger('S2');
    const api = makeApi();
    const platform = new PlatformCtor(
      log,
      { platform: 'RainMachineZones', address: 'https://127.0.0.1:9444', password: 'wrong' },
      api
    );
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 500));
    check(
      'error mentions password/401',
      log.lines.some((l) => l.includes('check the configured RainMachine password'))
    );
    clearInterval(platform._pollTimer);
    server.close();
  }

  // Scenario 3: unreachable host (nothing listening)
  {
    console.log('\n=== Scenario 3: unreachable host ===');
    const log = makeLogger('S3');
    const api = makeApi();
    const platform = new PlatformCtor(
      log,
      { platform: 'RainMachineZones', address: 'https://127.0.0.1:9999', password: 'pw' },
      api
    );
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 500));
    check('error mentions connection refused hint', log.lines.some((l) => l.includes('connection refused')));
    clearInterval(platform._pollTimer);
  }

  // Scenario 4: unresolvable hostname
  {
    console.log('\n=== Scenario 4: bad hostname ===');
    const log = makeLogger('S4');
    const api = makeApi();
    const platform = new PlatformCtor(
      log,
      { platform: 'RainMachineZones', address: 'https://no-such-host.invalid:8080', password: 'pw' },
      api
    );
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 1500));
    check('error mentions cannot resolve host', log.lines.some((l) => l.includes('cannot resolve host')));
    clearInterval(platform._pollTimer);
  }

  // Scenario 5: missing config (no address/password)
  {
    console.log('\n=== Scenario 5: missing config ===');
    const log = makeLogger('S5');
    const api = makeApi();
    const platform = new PlatformCtor(log, { platform: 'RainMachineZones' }, api);
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 200));
    check('address error logged', log.lines.some((l) => l.includes('No RainMachine address configured')));
    check('password error logged', log.lines.some((l) => l.includes('No RainMachine password configured')));
    check('discovery skipped message logged', log.lines.some((l) => l.includes('Skipping zone discovery')));
  }

  // Scenario 6: non-JSON response body
  {
    console.log('\n=== Scenario 6: non-JSON zone response ===');
    const server = await startMockServer(9445, { nonJson: true });
    const log = makeLogger('S6');
    const api = makeApi();
    const platform = new PlatformCtor(
      log,
      { platform: 'RainMachineZones', address: 'https://127.0.0.1:9445', password: 'pw' },
      api
    );
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 500));
    check('non-JSON warning logged', log.lines.some((l) => l.includes('non-JSON body')));
    check('zero zones warning logged', log.lines.some((l) => l.includes('zero zones')));
    clearInterval(platform._pollTimer);
    server.close();
  }

  // Scenario 7: externally-triggered zone state change is detected on poll
  {
    console.log('\n=== Scenario 7: externally-triggered zone change ===');
    const zones = [
      { uid: 1, name: 'Front Grass', active: true, state: 0, remaining: 0 },
      { uid: 2, name: 'Driveway', active: true, state: 0, remaining: 0 },
    ];
    const server = await startMockServer(9446, { zones });
    const log = makeLogger('S7');
    const api = makeApi();
    const platform = new PlatformCtor(
      log,
      { platform: 'RainMachineZones', address: 'https://127.0.0.1:9446', password: 'pw', pollInterval: 10 },
      api
    );
    api.emit('didFinishLaunching');
    await new Promise((r) => setTimeout(r, 400));
    zones[1] = { uid: 2, name: 'Driveway', active: true, state: 1, remaining: 300 };
    await platform.discoverZones();
    check(
      'external start detected',
      log.lines.some((l) => l.includes('Started zone "Driveway" externally'))
    );
    clearInterval(platform._pollTimer);
    server.close();
  }

  console.log(`\n\nTOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
