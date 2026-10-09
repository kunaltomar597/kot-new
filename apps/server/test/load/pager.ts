import { performance } from 'node:perf_hooks';
import {
  type PagerAlertMessage,
  PagerAlertMessage as PagerAlertSchema,
  type PagerCredentialResponse,
} from '@rp/contracts';
import mqtt, { type MqttClient } from 'mqtt';

/** An alert message as the pager received it. */
export interface PagerReceipt {
  readonly at: number;
  readonly message: PagerAlertMessage;
}

/** How often a pager reports its battery and signal (PGR-007: 30 s by default). */
const HEARTBEAT_MS = 30_000;

/**
 * A wrist pager on MQTT (P8-01a), as the firmware behaves: it connects with its own credential
 * over MQTTS pinned to the restaurant's CA, keeps its session (`clean: false`, QoS 1), sends a
 * heartbeat every 30 s, buzzes for each new alert and sends the button's acknowledgement. It
 * reconnects by itself after the broker goes away, and keeps when each connection came back.
 */
export class SimulatedPager {
  readonly receipts: PagerReceipt[] = [];
  /** When each connection after the first was made. */
  readonly reconnectedAt: number[] = [];
  private client: MqttClient | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private connections = 0;

  constructor(
    readonly credential: PagerCredentialResponse,
    /** The staff member wearing it, or null for a spare. */
    readonly wearerId: string | null,
  ) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  async connect(url: string, ca: string): Promise<void> {
    const client = await mqtt.connectAsync(url, {
      clientId: this.credential.deviceId,
      username: this.credential.mqttUsername,
      password: this.credential.mqttPassword,
      clean: false,
      ca,
      reconnectPeriod: 1_000,
      connectTimeout: 10_000,
    });
    this.client = client;
    this.connections = 1;
    client.on('connect', () => {
      this.connections += 1;
      if (this.connections > 1) this.reconnectedAt.push(performance.now());
    });
    client.on('message', (_topic, payload) => {
      const parsed = PagerAlertSchema.safeParse(JSON.parse(payload.toString()));
      if (parsed.success) this.receipts.push({ at: performance.now(), message: parsed.data });
    });
    client.on('error', () => undefined);
    await client.subscribeAsync(this.credential.alertsTopic, { qos: 1 });
    this.beat();
    this.heartbeat = setInterval(() => {
      this.beat();
    }, HEARTBEAT_MS);
  }

  /** The wearer pressed the button on this alert (NTF-004). */
  async acknowledge(alertId: string): Promise<void> {
    await this.client?.publishAsync(this.credential.ackTopic, JSON.stringify({ alertId }), {
      qos: 1,
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.client?.endAsync(true);
  }

  private beat(): void {
    if (this.client?.connected !== true) return;
    void this.client
      .publishAsync(
        this.credential.heartbeatTopic,
        JSON.stringify({ battery: 80, rssi: -55, firmware: '1.0.0' }),
        { qos: 0 },
      )
      .catch(() => undefined);
  }
}
