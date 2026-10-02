import type { FleetAlertView } from '@rp/contracts/control-plane';
import type { CpConfig } from '../config/cp-config.js';

/** Where fleet alerts go as they open and close, besides the web app (VCP-005). */
export const ALERT_NOTIFIER = Symbol('ALERT_NOTIFIER');

export interface AlertNotifier {
  /** False when there is nowhere to send alerts: they then count as sent. */
  readonly configured: boolean;
  /** Throws when the alert could not be delivered; it is tried again on the next sweep. */
  send(text: string, alert: FleetAlertView): Promise<void>;
}

const TIMEOUT_MS = 5_000;

/**
 * Posts `{ text, alert }` to an incoming webhook (Slack and Microsoft Teams take `text`). The
 * address comes from the secret manager (CP_ALERT_WEBHOOK_URL); it never appears in logs.
 */
export class WebhookAlertNotifier implements AlertNotifier {
  readonly configured: boolean;

  constructor(
    private readonly url: string | undefined,
    private readonly doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.configured = url !== undefined;
  }

  async send(text: string, alert: FleetAlertView): Promise<void> {
    if (this.url === undefined) return;
    const response = await this.doFetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, alert }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The alert webhook answered ${String(response.status)}`);
  }
}

export function alertNotifierFor(config: CpConfig): AlertNotifier {
  return new WebhookAlertNotifier(config.alertWebhookUrl);
}
