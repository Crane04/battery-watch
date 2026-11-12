import {
  SERVICE_UUID, NOTIFY_UUID, WRITE_UUID, CMD_BASIC, CMD_CELLS, CMD_MOS, CMD_FACTORY_ENTER, CMD_FACTORY_EXIT,
  FrameAssembler, buildRead, buildMos, parseBasic, parseCells, FACTORY_ENTER, FACTORY_EXIT,
} from './jbd.js';

// Same polling scheme as the app: ask for basic info, then cells, wait, repeat.
const POLL_GAP_MS = 3000;
const TIMEOUT_MS = 6000;
const CONNECT_TIMEOUT_MS = 10000;

// Sleep via a worker so polling keeps its pace while the tab is in the background.
const ticker = new Worker(new URL('./ticker.js', import.meta.url));
const wakeups = new Map();
let nextWake = 0;
ticker.onmessage = (e) => { wakeups.get(e.data)?.(); wakeups.delete(e.data); };
const sleep = (ms) => new Promise((r) => {
  const id = ++nextWake;
  wakeups.set(id, r);
  ticker.postMessage({ id, ms });
});

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

class JbdClient {
  device = null;
  notifyChar = null;
  writeChar = null;
  asm = new FrameAssembler();
  pending = null;
  // One request in flight at a time, so a MOSFET write can't collide with the poll loop.
  queue = Promise.resolve();
  lastCells = [];
  running = false;
  loopToken = 0;
  listeners = new Set();
  statusListeners = new Set();

  constructor() {
    this.onValue = this.onValue.bind(this);
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  onReading(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
  onStatus(l) { this.statusListeners.add(l); return () => this.statusListeners.delete(l); }
  status(s) { this.statusListeners.forEach((l) => l(s)); }

  get supported() { return !!navigator.bluetooth; }

  // Must be called straight from a click: Chrome only shows its device picker
  // in response to a user gesture.
  pick(showAll = false) {
    return navigator.bluetooth.requestDevice(showAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : {
        filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'JBD' }, { namePrefix: 'DP04' }],
        optionalServices: [SERVICE_UUID],
      });
  }

  // A battery chosen on an earlier visit, if Chrome still remembers the permission.
  async known(id) {
    if (!id || !navigator.bluetooth?.getDevices) return null;
    const devices = await navigator.bluetooth.getDevices().catch(() => []);
    return devices.find((d) => d.id === id) ?? null;
  }

  async start(device) {
    this.stop(true);
    this.running = true;
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      await this.connect();
    } catch (e) {
      this.stop(true);
      throw e;
    }
    this.loop();
    return device.id;
  }

  async connect() {
    this.status('Connecting…');
    const server = await withTimeout(this.device.gatt.connect(), CONNECT_TIMEOUT_MS,
      'Battery not reachable. Is it on and nearby?');
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);
    this.writeChar = await service.getCharacteristic(WRITE_UUID);
    this.asm.reset();
    this.notifyChar.addEventListener('characteristicvaluechanged', this.onValue);
    await this.notifyChar.startNotifications();
    this.status('Connected');
  }

  onValue(e) {
    const v = e.target.value;
    const bytes = Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    for (const f of this.asm.push(bytes)) {
      if (this.pending && this.pending.cmd === f.cmd) {
        const p = this.pending;
        this.pending = null;
        p.resolve(f);
      }
    }
  }

  onDisconnected() {
    this.cleanup();
    if (!this.running) return;
    this.status('Disconnected, retrying…');
    this.reconnect();
  }

  async reconnect() {
    let delay = 2000;
    while (this.running && !this.device?.gatt.connected) {
      await sleep(delay);
      if (!this.running) return;
      try {
        await this.connect();
        this.loop();
        return;
      } catch {
        this.status('Battery out of reach, retrying…');
        delay = Math.min(delay * 1.5, 15000);
      }
    }
  }

  send(packet, cmd) {
    const run = () => new Promise(async (resolve, reject) => {
      if (!this.writeChar) return reject(new Error('Not connected'));
      const t = setTimeout(() => { this.pending = null; reject(new Error('timeout')); }, TIMEOUT_MS);
      this.pending = { cmd, resolve: (f) => { clearTimeout(t); resolve(f); } };
      try {
        const bytes = new Uint8Array(packet);
        if (this.writeChar.properties.writeWithoutResponse) {
          await this.writeChar.writeValueWithoutResponse(bytes);
        } else {
          await this.writeChar.writeValueWithResponse(bytes);
        }
      } catch (e) { clearTimeout(t); this.pending = null; reject(e); }
    });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async request(cmd) {
    return (await this.send(buildRead(cmd), cmd)).data;
  }

  async writeMos(dischargeOn) {
    const f = await this.send(buildMos(true, dischargeOn), CMD_MOS).catch(() => null);
    return f?.status === 0;
  }

  // Opens or closes the discharge MOSFET, which cuts or restores power to the inverter.
  // Charging is always left enabled. Resolves with the BMS's actual state afterwards,
  // since a write can be accepted but overruled (e.g. a fault, or short-circuit trip on inrush).
  async setDischarge(on) {
    if (!this.writeChar) throw new Error('Not connected to the battery');
    let ok = await this.writeMos(on);
    if (!ok) {
      // Older firmware only accepts 0xE1 inside factory mode.
      await this.send(FACTORY_ENTER, CMD_FACTORY_ENTER).catch(() => {});
      ok = await this.writeMos(on);
      await this.send(FACTORY_EXIT, CMD_FACTORY_EXIT).catch(() => {});
    }
    // Give the BMS a moment to switch before reading back.
    await sleep(400);
    const info = parseBasic(await this.request(CMD_BASIC));
    this.listeners.forEach((l) => l({ info, cells: this.lastCells, at: Date.now() }));
    if (info.dischargeMos !== on) {
      throw new Error(ok
        ? `The BMS accepted the command but output is still ${info.dischargeMos ? 'on' : 'off'}.`
        : 'The BMS did not accept the command.');
    }
    return info;
  }

  stop(silent = false) {
    this.running = false;
    this.loopToken++;
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      if (this.device.gatt.connected) this.device.gatt.disconnect();
    }
    this.cleanup();
    this.device = null;
    if (!silent) this.status('Stopped');
  }

  cleanup() {
    this.notifyChar?.removeEventListener('characteristicvaluechanged', this.onValue);
    this.notifyChar = null;
    this.writeChar = null;
    this.pending = null;
    this.queue = Promise.resolve();
  }

  async loop() {
    // Only one poll loop at a time, even across reconnects.
    const token = ++this.loopToken;
    while (this.running && this.writeChar && token === this.loopToken) {
      try {
        const info = parseBasic(await this.request(CMD_BASIC));
        const cells = parseCells(await this.request(CMD_CELLS));
        this.lastCells = cells;
        const r = { info, cells, at: Date.now() };
        this.listeners.forEach((l) => l(r));
      } catch {
        // one missed poll is fine; the disconnect handler covers real drops
      }
      await sleep(POLL_GAP_MS);
    }
  }
}

export const jbd = new JbdClient();
