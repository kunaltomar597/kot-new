import type { ResumePoint, StoredDevice } from '@rp/api-client';
import { DeviceSummary, LoginResponse } from '@rp/contracts';
import { z } from 'zod';

/**
 * What the console keeps between visits:
 *
 * - the device: its key pair (the private key is non-extractable; IndexedDB stores the key object
 *   itself, never the key's bytes, SEC-006), device token and summary, in IndexedDB;
 * - the signed-in person's session: in `sessionStorage`, so it lives only as long as this tab and a
 *   shared terminal never reopens signed in;
 * - the live-update resume point: in `localStorage` (not secret).
 */
export interface DeviceRecord {
  readonly keyPair: CryptoKeyPair;
  readonly device: StoredDevice;
  readonly summary: DeviceSummary;
}

export interface ConsoleStorage {
  loadDevice(): Promise<DeviceRecord | undefined>;
  saveDevice(record: DeviceRecord | undefined): Promise<void>;
  loadSession(): LoginResponse | undefined;
  saveSession(session: LoginResponse | undefined): void;
  loadResume(): ResumePoint | undefined;
  saveResume(point: ResumePoint | undefined): void;
}

const DATABASE = 'rp-console';
const STORE = 'device';
const RECORD_KEY = 'this-device';
const SESSION_KEY = 'rp-console.session';
const RESUME_KEY = 'rp-console.resume';

const StoredRecord = z.object({
  keyPair: z.custom<CryptoKeyPair>(
    (value) =>
      typeof value === 'object' && value !== null && 'privateKey' in value && 'publicKey' in value,
  ),
  device: z.object({
    deviceId: z.string(),
    deviceToken: z.string().optional(),
    deviceTokenExpiresAt: z.string().optional(),
  }),
  summary: DeviceSummary,
});

const Resume = z.object({ lastSequence: z.int().nonnegative(), streamId: z.uuid() });

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/** The browser's storage. */
export class BrowserStorage implements ConsoleStorage {
  private database: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly indexedDb: IDBFactory = globalThis.indexedDB,
    private readonly tab: Storage = globalThis.sessionStorage,
    private readonly local: Storage = globalThis.localStorage,
  ) {}

  async loadDevice(): Promise<DeviceRecord | undefined> {
    const store = await this.store('readonly');
    const parsed = StoredRecord.safeParse(await requestResult(store.get(RECORD_KEY)));
    return parsed.success ? parsed.data : undefined;
  }

  async saveDevice(record: DeviceRecord | undefined): Promise<void> {
    const store = await this.store('readwrite');
    if (record === undefined) await requestResult(store.delete(RECORD_KEY));
    else await requestResult(store.put(record, RECORD_KEY));
  }

  loadSession(): LoginResponse | undefined {
    return this.read(this.tab, SESSION_KEY, LoginResponse);
  }

  saveSession(session: LoginResponse | undefined): void {
    this.write(this.tab, SESSION_KEY, session);
  }

  loadResume(): ResumePoint | undefined {
    return this.read(this.local, RESUME_KEY, Resume);
  }

  saveResume(point: ResumePoint | undefined): void {
    this.write(this.local, RESUME_KEY, point);
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    this.database ??= new Promise((resolve, reject) => {
      const open = this.indexedDb.open(DATABASE, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(open.error ?? new Error('IndexedDB is not available'));
      };
    });
    return (await this.database).transaction(STORE, mode).objectStore(STORE);
  }

  private read<T>(storage: Storage, key: string, schema: z.ZodType<T>): T | undefined {
    const text = storage.getItem(key);
    if (text === null) return undefined;
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private write(storage: Storage, key: string, value: unknown): void {
    if (value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  }
}

/** Keeps everything in memory (tests, and browsers where storage is blocked). */
export class MemoryStorage implements ConsoleStorage {
  device: DeviceRecord | undefined;
  session: LoginResponse | undefined;
  resume: ResumePoint | undefined;

  loadDevice(): Promise<DeviceRecord | undefined> {
    return Promise.resolve(this.device);
  }

  saveDevice(record: DeviceRecord | undefined): Promise<void> {
    this.device = record;
    return Promise.resolve();
  }

  loadSession(): LoginResponse | undefined {
    return this.session;
  }

  saveSession(session: LoginResponse | undefined): void {
    this.session = session;
  }

  loadResume(): ResumePoint | undefined {
    return this.resume;
  }

  saveResume(point: ResumePoint | undefined): void {
    this.resume = point;
  }
}
