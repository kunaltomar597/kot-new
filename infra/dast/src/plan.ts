import { urlsUnder } from './credentials.js';

/** The surfaces scanned (P8-03c1), each started as it runs for real. */
export const TARGETS = ['qr-site', 'relay', 'control-plane', 'local-server'] as const;
export type TargetName = (typeof TARGETS)[number];

/** One surface to scan: what ZAP spiders, imports and attacks. */
export interface ScanTarget {
  readonly name: TargetName;
  /** The origin the surface answers on; nothing outside it is requested or attacked. */
  readonly baseUrl: string;
  /** Pages spidered and passively scanned, as full URLs. */
  readonly pages: readonly string[];
  /** The OpenAPI document (a file in the run's folder) whose operations are imported and attacked. */
  readonly openApi?: { readonly file: string; readonly targetUrl: string };
  /** URL patterns (Java regular expressions) ZAP must not request, each with why. */
  readonly exclude: readonly { readonly url: string; readonly why: string }[];
  /** The longest the active scan may run. */
  readonly activeScanMinutes: number;
}

/**
 * Active scan rules turned off, with why: they look for software none of the surfaces has, or
 * need what the scan does not give ZAP (a browser, callbacks over the internet). ZAP's rule ids,
 * only of rules ZAP has: naming one it lacks is a plan warning, and the scan fails on it. (SQL
 * injection, SQLite, 40024, left the release rules in ascanrules 79 and is not in the image.)
 */
export const RULES_OFF: Readonly<Record<string, string>> = {
  '30001': 'Buffer overflow: no native code reads requests (Node.js and Deno)',
  '30002': 'Format string error: no native code reads requests',
  '40009': 'Server-side include: no server parses SSI',
  '40019': 'SQL injection, MySQL: every database is PostgreSQL',
  '40020': 'SQL injection, Hypersonic: every database is PostgreSQL',
  '40021': 'SQL injection, Oracle: every database is PostgreSQL',
  '40027': 'SQL injection, MsSQL: every database is PostgreSQL',
  '40026':
    'Cross-site scripting (DOM based) drives a browser inside ZAP; the console and the QR site are checked in Playwright under their CSP and Trusted Types instead',
  '40043': 'Log4Shell: no Java, and it needs callbacks over the internet',
  '10104': 'User agent fuzzer: reports differences only, no vulnerability',
};

/**
 * The Automation Framework plan for a target (written as JSON, which ZAP reads as YAML): request
 * headers from `headers.js` (credentials that the run keeps fresh), the OpenAPI operations
 * imported, the pages spidered, everything passively scanned, then actively attacked, and the
 * reports. `folder` is the run's folder as ZAP sees it.
 */
export function automationPlan(target: ScanTarget, folder: string): Record<string, unknown> {
  const context = target.name;
  const jobs: Record<string, unknown>[] = [
    {
      type: 'script',
      parameters: {
        action: 'add',
        type: 'httpsender',
        engine: 'Graal.js',
        name: 'credentials',
        file: `${folder}/headers.js`,
      },
    },
    { type: 'script', parameters: { action: 'enable', type: 'httpsender', name: 'credentials' } },
  ];
  if (target.openApi !== undefined) {
    jobs.push({
      type: 'openapi',
      parameters: {
        apiFile: `${folder}/${target.openApi.file}`,
        targetUrl: target.openApi.targetUrl,
        context,
      },
    });
  }
  for (const page of target.pages) {
    jobs.push({
      type: 'spider',
      parameters: { context, url: page, maxDuration: 1, maxDepth: 3 },
    });
  }
  jobs.push(
    { type: 'passiveScan-wait', parameters: { maxDuration: 5 } },
    {
      type: 'activeScan',
      parameters: {
        context,
        maxScanDurationInMins: target.activeScanMinutes,
        maxRuleDurationInMins: 3,
        threadPerHost: 4,
      },
      policyDefinition: {
        defaultStrength: 'medium',
        defaultThreshold: 'medium',
        rules: Object.keys(RULES_OFF).map((id) => ({ id: Number(id), threshold: 'off' })),
      },
    },
    { type: 'passiveScan-wait', parameters: { maxDuration: 5 } },
    ...(['json', 'md'] as const).map((format) => ({
      type: 'report',
      parameters: {
        template: `traditional-${format}`,
        reportDir: folder,
        reportFile: `${target.name}.${format}`,
        reportTitle: `DAST: ${target.name}`,
      },
    })),
  );
  return {
    env: {
      contexts: [
        {
          name: context,
          urls: [target.baseUrl],
          includePaths: [`${urlsUnder(target.baseUrl)}.*`],
          excludePaths: target.exclude.map((rule) => rule.url),
        },
      ],
      parameters: { failOnError: true, failOnWarning: false, progressToStdout: true },
    },
    jobs,
  };
}
