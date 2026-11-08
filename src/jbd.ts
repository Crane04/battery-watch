// JBD BMS Bluetooth protocol (JBD-DP04S007 and most "xiaoxiang" BMS boards)
// Request:  DD A5 <cmd> 00 <chk_hi> <chk_lo> 77
// Response: DD <cmd> <status> <len> <data...> <chk_hi> <chk_lo> 77
// Checksum: 0x10000 - sum(status, len, data) (for requests: sum(cmd, len))

export const SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
export const NOTIFY_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';
export const WRITE_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';

export const CMD_BASIC = 0x03;
export const CMD_CELLS = 0x04;

export function buildRead(cmd: number): number[] {
  const chk = (0x10000 - (cmd + 0x00)) & 0xffff;
  return [0xdd, 0xa5, cmd, 0x00, chk >> 8, chk & 0xff, 0x77];
}

export type Frame = { cmd: number; status: number; data: number[] };

export type BasicInfo = {
  voltage: number; // V
  current: number; // A, negative = discharging
  power: number; // W, negative = discharging
  remainingAh: number;
  nominalAh: number;
  cycles: number;
  soc: number; // %
  chargeMos: boolean;
  dischargeMos: boolean;
  balancing: boolean;
  protections: string[];
  cellCount: number;
  temps: number[]; // °C
};

const PROTECTION_BITS = [
  'Cell overvoltage',
  'Cell undervoltage',
  'Pack overvoltage',
  'Pack undervoltage',
  'Charge overtemp',
  'Charge undertemp',
  'Discharge overtemp',
  'Discharge undertemp',
  'Charge overcurrent',
  'Discharge overcurrent',
  'Short circuit',
  'Frontend IC error',
  'MOS software lock',
];

function checksum(bytes: number[]): number {
  const sum = bytes.reduce((a, b) => a + b, 0);
  return (0x10000 - sum) & 0xffff;
}

// BLE notifications arrive in ~20 byte chunks, so frames must be reassembled.
export class FrameAssembler {
  private buf: number[] = [];

  push(chunk: number[]): Frame[] {
    this.buf.push(...chunk);
    const frames: Frame[] = [];

    while (true) {
      const start = this.buf.indexOf(0xdd);
      if (start === -1) {
        this.buf = [];
        break;
      }
      if (start > 0) this.buf.splice(0, start);
      if (this.buf.length < 4) break;

      const len = this.buf[3];
      const total = 4 + len + 3;
      if (this.buf.length < total) break;

      const raw = this.buf.splice(0, total);
      if (raw[total - 1] !== 0x77) continue; // corrupt, resync

      const status = raw[2];
      const data = raw.slice(4, 4 + len);
      const got = (raw[4 + len] << 8) | raw[5 + len];
      if (got !== checksum([status, len, ...data])) continue;

      frames.push({ cmd: raw[1], status, data });
    }
    return frames;
  }

  reset() {
    this.buf = [];
  }
}

const u16 = (d: number[], i: number) => (d[i] << 8) | d[i + 1];
const s16 = (v: number) => (v > 0x7fff ? v - 0x10000 : v);

export function parseBasic(d: number[]): BasicInfo {
  const voltage = u16(d, 0) / 100;
  const current = s16(u16(d, 2)) / 100;
  const protectionWord = u16(d, 16);
  const balanceWord = u16(d, 12) | (u16(d, 14) << 16);
  const fet = d[20];
  const ntcCount = d[22];

  const temps: number[] = [];
  for (let i = 0; i < ntcCount; i++) {
    temps.push(Math.round((u16(d, 23 + i * 2) - 2731)) / 10);
  }

  return {
    voltage,
    current,
    power: Math.round(voltage * current * 100) / 100,
    remainingAh: u16(d, 4) / 100,
    nominalAh: u16(d, 6) / 100,
    cycles: u16(d, 8),
    soc: d[19],
    chargeMos: (fet & 0x01) !== 0,
    dischargeMos: (fet & 0x02) !== 0,
    balancing: balanceWord !== 0,
    protections: PROTECTION_BITS.filter((_, bit) => protectionWord & (1 << bit)),
    cellCount: d[21],
    temps,
  };
}

export function parseCells(d: number[]): number[] {
  const cells: number[] = [];
  for (let i = 0; i + 1 < d.length; i += 2) cells.push(u16(d, i) / 1000);
  return cells;
}

// Hours until the pack reaches a given %, based on current draw.
export function hoursToPercent(info: BasicInfo, targetPct: number): number | null {
  if (info.current >= 0) return null;
  const targetAh = (info.nominalAh * targetPct) / 100;
  const ahLeft = info.remainingAh - targetAh;
  if (ahLeft <= 0) return 0;
  return ahLeft / Math.abs(info.current);
}

// base64 helpers (react-native-ble-plx speaks base64)
export function b64ToBytes(b64: string): number[] {
  const bin = atob(b64);
  const out: number[] = [];
  for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
  return out;
}

export function bytesToB64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
