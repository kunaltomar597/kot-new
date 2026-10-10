import { mkdtempSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { headerScript, urlsUnder, writeHeaderRules } from '../src/credentials.js';
import { forZap, SAMPLE_ID } from '../src/openapi.js';
import { automationPlan, RULES_OFF, type ScanTarget } from '../src/plan.js';
import { alertsOf, type ZapAlert } from '../src/report.js';
import { triageEntries } from '../src/scan.js';
import { summary } from '../src/summary.js';
import { judge, type TriageEntry, triageProblems } from '../src/triage.js';
import { zapCommand, zapFolder, zapRunnerFrom } from '../src/zap.js';

const alert = (overrides: Partial<ZapAlert> = {}): ZapAlert => ({
  pluginId: '10035',
  alertRef: '10035-1',
  name: 'Strict-Transport-Security Header Not Set',
  risk: 'Low',
  confidence: 'High',
  cweId: '319',
  instances: ['GET https://127.0.0.1:4430/api/v1/health'],
  ...overrides,
});

const entry = (overrides: Partial<TriageEntry> = {}): TriageEntry => ({
  target: 'local-server',
  alert: '10035',
  name: 'Strict-Transport-Security Header Not Set',
  decision: 'accepted',
  reason: 'A reason long enough for anyone to check it later.',
  ...overrides,
});

describe('[SEC-017] what stops a DAST run', () => {
  it('needs every finding triaged, everywhere it was seen', () => {
    const seen = alert({
      instances: ['GET https://127.0.0.1:4430/api/v1/health', 'GET https://127.0.0.1:4430/ca.crt'],
    });
    expect(judge('local-server', [seen], []).open).toEqual([{ alert: seen, why: 'untriaged' }]);
    const narrow = entry({ where: '/api/' });
    const judged = judge('local-server', [seen], [narrow]);
    expect(judged.open).toEqual([
      {
        alert: { ...seen, instances: ['GET https://127.0.0.1:4430/ca.crt'] },
        why: 'outside-triaged-urls',
      },
    ]);
    const both = judge('local-server', [seen], [narrow, entry({ where: '/ca\\.crt$' })]);
    expect(both.open).toEqual([]);
    expect(both.triaged).toHaveLength(1);
    expect(both.used).toHaveLength(2);
  });

  it('keeps a High open unless ZAP is shown to be wrong about it', () => {
    const high = alert({
      pluginId: '40018',
      alertRef: '40018',
      name: 'SQL Injection',
      risk: 'High',
    });
    const accepted = entry({ alert: '40018', name: 'SQL Injection' });
    expect(judge('local-server', [high], [accepted]).open).toEqual([
      { alert: high, why: 'high-accepted' },
    ]);
    const wrong = entry({ alert: '40018', name: 'SQL Injection', decision: 'false-positive' });
    expect(judge('local-server', [high], [wrong]).open).toEqual([]);
  });

  it('matches a rule, or one kind of its alerts, on its surface or on all of them', () => {
    const csp = alert({
      pluginId: '10055',
      alertRef: '10055-4',
      name: 'CSP: style-src unsafe-inline',
    });
    expect(
      judge('qr-site', [csp], [entry({ target: 'qr-site', alert: '10055-6' })]).open,
    ).toHaveLength(1);
    expect(judge('qr-site', [csp], [entry({ target: 'qr-site', alert: '10055-4' })]).open).toEqual(
      [],
    );
    expect(judge('qr-site', [csp], [entry({ target: '*', alert: '10055' })]).open).toEqual([]);
    expect(judge('qr-site', [csp], [entry({ target: 'relay', alert: '10055' })]).open).toHaveLength(
      1,
    );
  });

  it('lists informational alerts without judging them', () => {
    const info = alert({ risk: 'Informational', pluginId: '10027', alertRef: '10027' });
    expect(judge('relay', [info], [])).toMatchObject({ open: [], informational: [info] });
  });

  it('refuses a triage entry without a full reason, a rule id or a known surface', () => {
    expect(
      triageProblems([
        entry({ reason: 'because', where: '/api/' }),
        entry({ alert: 'HSTS', where: '(' }),
        entry({ target: 'kiosk' as TriageEntry['target'] }),
        entry(),
        entry(),
      ]),
    ).toEqual([
      'entry 1 (10035 Strict-Transport-Security Header Not Set): give the reason in full',
      'entry 2 (HSTS Strict-Transport-Security Header Not Set): alert is not a ZAP rule id',
      'entry 2 (HSTS Strict-Transport-Security Header Not Set): where is not a regular expression',
      'entry 3 (10035 Strict-Transport-Security Header Not Set): unknown target kiosk',
      'entry 5 (10035 Strict-Transport-Security Header Not Set): the same finding is triaged twice',
    ]);
  });

  it('has a sound triage file, with no High accepted', () => {
    const entries = triageEntries();
    expect(triageProblems(entries)).toEqual([]);
    for (const triaged of entries) expect(triaged.reason).not.toMatch(/TODO|TBD/);
  });
});

describe('[SEC-017] reading ZAP and telling ZAP what to do', () => {
  it('reads the report for the scanned origin only', () => {
    const report = {
      site: [
        {
          '@name': 'https://127.0.0.1:4430',
          alerts: [
            {
              pluginid: '10021',
              alertRef: '10021',
              alert: 'X-Content-Type-Options Header Missing',
              riskcode: '1',
              confidence: '2',
              cweid: '693',
              instances: [{ uri: 'https://127.0.0.1:4430/ca.crt', method: 'GET' }],
            },
          ],
        },
        { '@name': 'https://example.com', alerts: [{ pluginid: '1', riskcode: '3' }] },
      ],
    };
    expect(alertsOf(report, 'https://127.0.0.1:4430')).toEqual([
      {
        pluginId: '10021',
        alertRef: '10021',
        name: 'X-Content-Type-Options Header Missing',
        risk: 'Low',
        confidence: '2',
        cweId: '693',
        instances: ['GET https://127.0.0.1:4430/ca.crt'],
      },
    ]);
  });

  it('plans the script, the import, the spider, both scans and the reports, in that order', () => {
    const target: ScanTarget = {
      name: 'control-plane',
      baseUrl: 'http://127.0.0.1:8080',
      pages: ['http://127.0.0.1:8080/'],
      openApi: { file: 'control-plane.openapi.json', targetUrl: 'http://127.0.0.1:8080' },
      exclude: [{ url: 'http://127\\.0\\.0\\.1:8080/v1/vendor/session', why: 'own session' }],
      activeScanMinutes: 15,
    };
    const plan = automationPlan(target, '/zap/wrk') as {
      env: { contexts: { includePaths: string[]; excludePaths: string[] }[] };
      jobs: { type: string; parameters: Record<string, unknown>; policyDefinition?: unknown }[];
    };
    expect(plan.jobs.map((job) => job.type)).toEqual([
      'script',
      'script',
      'openapi',
      'spider',
      'passiveScan-wait',
      'activeScan',
      'passiveScan-wait',
      'report',
      'report',
    ]);
    expect(plan.env.contexts[0]).toMatchObject({
      includePaths: ['^http://127\\.0\\.0\\.1:8080/.*'],
      excludePaths: ['http://127\\.0\\.0\\.1:8080/v1/vendor/session'],
    });
    expect(plan.jobs[0]?.parameters.file).toBe('/zap/wrk/headers.js');
    expect(plan.jobs[2]?.parameters.apiFile).toBe('/zap/wrk/control-plane.openapi.json');
    const active = plan.jobs[5];
    expect(active?.parameters.maxScanDurationInMins).toBe(15);
    expect(active?.policyDefinition).toMatchObject({
      rules: Object.keys(RULES_OFF).map((id) => ({ id: Number(id), threshold: 'off' })),
    });
    // SQL injection in general and PostgreSQL's stay on.
    expect(Object.keys(RULES_OFF)).not.toContain('40018');
    expect(Object.keys(RULES_OFF)).not.toContain('40022');
  });

  it('gives ZAP an id where the OpenAPI document has only the pattern of one', () => {
    const id = { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]{36}$' };
    const document = {
      paths: {
        '/api/v1/menu/items/{id}': {
          get: { parameters: [{ name: 'id', in: 'path', schema: id }] },
        },
      },
      components: {
        schemas: {
          Ref: { type: 'object', properties: { itemId: id, other: { ...id, example: 'kept' } } },
        },
      },
    };
    expect(forZap(document)).toEqual({
      paths: {
        '/api/v1/menu/items/{id}': {
          get: { parameters: [{ name: 'id', in: 'path', schema: { ...id, example: SAMPLE_ID } }] },
        },
      },
      components: {
        schemas: {
          Ref: {
            type: 'object',
            properties: {
              itemId: { ...id, example: SAMPLE_ID },
              other: { ...id, example: 'kept' },
            },
          },
        },
      },
    });
  });

  it('runs an installed ZAP or its container, as configured', () => {
    expect(zapRunnerFrom({})).toBeUndefined();
    const local = zapRunnerFrom({ ZAP_PATH: '/opt/zap/zap.sh' });
    const docker = zapRunnerFrom({ ZAP_DOCKER_IMAGE: 'ghcr.io/zaproxy/zaproxy@sha256:abc' });
    if (local === undefined || docker === undefined) throw new Error('no runner');
    expect(zapCommand(local, '/tmp/run', 'plan.yaml')).toEqual({
      command: '/opt/zap/zap.sh',
      args: ['-cmd', '-dir', '/tmp/run/home', '-autorun', '/tmp/run/plan.yaml'],
    });
    expect(zapFolder(docker, '/tmp/run')).toBe('/zap/wrk');
    expect(zapCommand(docker, '/tmp/run', 'plan.yaml').args).toEqual([
      'run',
      '--rm',
      '--network',
      'host',
      '-v',
      '/tmp/run:/zap/wrk:rw',
      'ghcr.io/zaproxy/zaproxy@sha256:abc',
      'zap.sh',
      '-cmd',
      '-autorun',
      '/zap/wrk/plan.yaml',
    ]);
  });

  it('adds the latest credentials to each request, from the file the run keeps fresh', () => {
    const folder = mkdtempSync(join(tmpdir(), 'dast-headers-'));
    const file = join(folder, 'headers.json');
    // ZAP's Java, as far as the script uses it.
    const Java = {
      type: (name: string) =>
        ({
          'java.nio.file.Paths': { get: (path: string) => path },
          'java.nio.file.Files': {
            getLastModifiedTime: (path: string) => ({ toMillis: () => statSync(path).mtimeMs }),
            readAllBytes: (path: string) => readFileSync(path),
          },
          'java.lang.String': function JString(bytes: Buffer) {
            return { toString: () => bytes.toString('utf8') };
          },
        })[name],
    };
    const script = runInNewContext(`${headerScript(folder)}; ({ sendingRequest })`, {
      Java,
    }) as { sendingRequest: (message: unknown) => void };
    const send = (url: string) => {
      const set: Record<string, string> = {};
      script.sendingRequest({
        getRequestHeader: () => ({
          getURI: () => ({ toString: () => url }),
          setHeader: (name: string, value: string) => {
            set[name] = value;
          },
        }),
      });
      return set;
    };
    const api = urlsUnder('https://127.0.0.1:4430', '/api/');
    writeHeaderRules(folder, [{ url: api, headers: { authorization: 'Bearer one' } }]);
    expect(send('https://127.0.0.1:4430/api/v1/orders')).toEqual({ authorization: 'Bearer one' });
    expect(send('https://127.0.0.1:4430/pos')).toEqual({});
    expect(send('https://127.0.0.1:44301/api/v1/orders')).toEqual({});
    writeHeaderRules(folder, [{ url: api, headers: { authorization: 'Bearer two' } }]);
    // A new token is seen as soon as the file changed.
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(send('https://127.0.0.1:4430/api/v1/orders')).toEqual({ authorization: 'Bearer two' });
  });

  it('sums up each surface, what is open and the entries no finding needed', () => {
    const seen = alert();
    const used = entry();
    const spare = entry({ target: 'relay', alert: '10021', name: 'X-Content-Type-Options' });
    const text = summary(
      [
        judge(
          'local-server',
          [
            seen,
            alert({ risk: 'High', alertRef: '40018', pluginId: '40018', name: 'SQL Injection' }),
          ],
          [used],
        ),
        judge('relay', [], [spare]),
      ],
      [used, spare],
      ['local-server', 'relay'],
    );
    expect(text).toContain('| local-server | 1 | 0 | 1 | 0 | 1 |');
    expect(text).toContain('- **High** 40018 SQL Injection (not triaged)');
    expect(text).toContain('- Low 10035-1 Strict-Transport-Security Header Not Set: accepted.');
    expect(text).toContain('- relay 10021 X-Content-Type-Options');
  });
});
