/** ZAP's risk levels, from its `riskcode`. */
export const RISKS = ['Informational', 'Low', 'Medium', 'High'] as const;
export type Risk = (typeof RISKS)[number];

/** One kind of finding on one surface, with where ZAP saw it. */
export interface ZapAlert {
  /** The rule's id, and the alert's own when a rule raises several kinds (`10055-4`). */
  readonly pluginId: string;
  readonly alertRef: string;
  readonly name: string;
  readonly risk: Risk;
  readonly confidence: string;
  readonly cweId: string;
  /** `METHOD url` of each place it was seen. */
  readonly instances: readonly string[];
}

interface RawInstance {
  readonly uri?: string;
  readonly method?: string;
}

interface RawAlert {
  readonly pluginid: string;
  readonly alertRef?: string;
  readonly alert?: string;
  readonly name?: string;
  readonly riskcode: string;
  readonly confidence?: string;
  readonly cweid?: string;
  readonly instances?: readonly RawInstance[];
}

interface RawReport {
  readonly site?: readonly { readonly '@name': string; readonly alerts?: readonly RawAlert[] }[];
}

/**
 * The alerts of ZAP's `traditional-json` report on the scanned origin only (ZAP may also list
 * sites it saw in passing, which are not the target's).
 */
export function alertsOf(report: unknown, origin: string): ZapAlert[] {
  const sites = (report as RawReport).site ?? [];
  const alerts: ZapAlert[] = [];
  for (const site of sites) {
    if (new URL(site['@name']).origin !== new URL(origin).origin) continue;
    for (const raw of site.alerts ?? []) {
      const risk = RISKS[Number(raw.riskcode)];
      if (risk === undefined) throw new Error(`Unknown ZAP risk code ${raw.riskcode}`);
      alerts.push({
        pluginId: raw.pluginid,
        alertRef: raw.alertRef ?? raw.pluginid,
        name: raw.alert ?? raw.name ?? raw.pluginid,
        risk,
        confidence: raw.confidence ?? '',
        cweId: raw.cweid ?? '',
        instances: (raw.instances ?? []).map(
          (instance) => `${instance.method ?? 'GET'} ${instance.uri ?? ''}`,
        ),
      });
    }
  }
  return alerts;
}
