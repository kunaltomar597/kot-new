import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import {
  CreateVendorUserRequest,
  DeviceLimits,
  LicenceState,
  RELEASE_CHANNELS,
  RELEASE_COMPONENTS,
  type ReleaseChannel,
  type ReleaseComponent,
  VersionMatrix,
} from '@rp/contracts/control-plane';
import { AdminService } from './admin/admin.service.js';
import { ControlPlaneModule } from './app.module.js';
import { loadConfig } from './config/cp-config.js';
import { CpError } from './errors/cp-error.js';
import { type LicenceSummary, LicencesService } from './licences/licences.service.js';
import { VendorAuthService } from './vendor/vendor-auth.service.js';

/**
 * Admin CLI for vendor staff until the web app (VCP-001, P7-02). It talks to the database of the
 * environment in DATABASE_URL, so it runs from the release pipeline or an operator host, never
 * from a laptop against production (ADR-0012). Every command is audited with its actor.
 *
 *   pnpm --filter @rp/control-plane cli <command> [options]
 */
export const USAGE = `Usage: pnpm --filter @rp/control-plane cli <command> [options]

Commands:
  tenant:create --name <name>
  installation:create --tenant <tenant id> --name <name> [--channel STABLE|PILOT]
  installation:code --installation <id>             new code for an installation not enrolled yet
  installation:revoke --installation <id> --reason <text>
  installations:list
  release:publish --channel STABLE|PILOT --version <x.y.z> --url <https url>
                  --sha256 <hex> --size <bytes> [--notes <text>]
                  [--component RESTAURANT_PC|PAGER_FIRMWARE] (default RESTAURANT_PC)
                  [--matrix <version-matrix.json from the packaging step>]
  vendor-user:create --email <email> --name <name> --role SUPER_ADMIN|ONBOARDING|SUPPORT|FINANCE|READ_ONLY
                     the first Super Admin; prints the one-time setup token
  licence:show --installation <id>
  licence:set --installation <id> --reason <text> [--state ACTIVE|PAYMENT_DUE|GRACE|RESTRICTED|TERMINATED]
              [--plan <name>] [--limits TABLE_TABLET=30,PAGER=15,WAITER_PHONE=15,KDS=6]
              [--validity-days <n>] [--grace-days <n>]
  licence:rebind --installation <id> --reason <text>   move the licence to a new PC
  licence:code --installation <id> --until <YYYY-MM-DD>  offline reactivation code (shown once)

The actor recorded in the audit log is CP_ACTOR (cli:<name> or ci:<pipeline>), by default
cli:<operating-system user>.`;

const OPTIONS = {
  name: { type: 'string' },
  tenant: { type: 'string' },
  installation: { type: 'string' },
  channel: { type: 'string' },
  reason: { type: 'string' },
  version: { type: 'string' },
  url: { type: 'string' },
  sha256: { type: 'string' },
  size: { type: 'string' },
  notes: { type: 'string' },
  matrix: { type: 'string' },
  component: { type: 'string' },
  state: { type: 'string' },
  plan: { type: 'string' },
  limits: { type: 'string' },
  'validity-days': { type: 'string' },
  'grace-days': { type: 'string' },
  until: { type: 'string' },
  email: { type: 'string' },
  role: { type: 'string' },
  help: { type: 'boolean' },
} as const;

const ACTOR = /^(cli|ci):[A-Za-z0-9._@-]{1,64}$/;

/** Who the audit log names: CP_ACTOR, or `cli:<operating-system user>`. */
export function actorFrom(env: NodeJS.ProcessEnv = process.env): string {
  const actor = env.CP_ACTOR ?? `cli:${userInfo().username}`;
  if (!ACTOR.test(actor)) {
    throw new CpError(400, 'VALIDATION_FAILED', 'CP_ACTOR must look like cli:<name> or ci:<name>.');
  }
  return actor;
}

function required(values: Readonly<Record<string, unknown>>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CpError(400, 'VALIDATION_FAILED', `--${name} is required.`);
  }
  return value;
}

function channelOf(value: unknown): ReleaseChannel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (RELEASE_CHANNELS as readonly string[]).includes(value)) {
    return value as ReleaseChannel;
  }
  throw new CpError(
    400,
    'VALIDATION_FAILED',
    `--channel must be one of ${RELEASE_CHANNELS.join(', ')}.`,
  );
}

/** What a release installs (PGR-011: pager firmware too); the installer by default. */
function componentOf(value: unknown): ReleaseComponent {
  if (value === undefined) return 'RESTAURANT_PC';
  if (typeof value === 'string' && (RELEASE_COMPONENTS as readonly string[]).includes(value)) {
    return value as ReleaseComponent;
  }
  throw new CpError(
    400,
    'VALIDATION_FAILED',
    `--component must be one of ${RELEASE_COMPONENTS.join(', ')}.`,
  );
}

/** `TABLE_TABLET=30,PAGER=15,...` as device limits. */
function limitsOf(text: string): DeviceLimits {
  const entries = text.split(',').map((pair) => {
    const [key = '', value = ''] = pair.split('=');
    return [key.trim(), Number(value)] as const;
  });
  const parsed = DeviceLimits.safeParse(Object.fromEntries(entries));
  if (!parsed.success) {
    throw new CpError(
      400,
      'VALIDATION_FAILED',
      '--limits must give TABLE_TABLET, PAGER, WAITER_PHONE and KDS, like TABLE_TABLET=30,PAGER=15,WAITER_PHONE=15,KDS=6.',
    );
  }
  return parsed.data;
}

function daysOf(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new CpError(400, 'VALIDATION_FAILED', `--${name} must be a whole number of days.`);
  }
  return days;
}

function printLicence(summary: LicenceSummary, out: (line: string) => void): void {
  out(`Installation ${summary.installationId}: ${summary.state}, plan ${summary.plan}`);
  if (summary.reason !== null) out(`Reason: ${summary.reason}`);
  out(
    `Devices: ${Object.entries(summary.deviceLimits)
      .map(([type, limit]) => `${type}=${String(limit)}`)
      .join(', ')}`,
  );
  out(`Valid ${String(summary.validityDays)} days, ${String(summary.graceDays)} days of grace`);
  out(`Bound to a PC: ${summary.boundAt?.toISOString() ?? 'not yet'}`);
  out(
    summary.latest === null
      ? 'No licence issued yet.'
      : `Latest licence ${summary.latest.id}, issued ${summary.latest.issuedAt.toISOString()}, valid until ${summary.latest.validUntil.toISOString()}`,
  );
}

export interface CliContext {
  readonly admin: AdminService;
  /** Licences (P7-01b); commands about them need it. */
  readonly licences?: LicencesService;
  /** Vendor staff accounts (P7-02a). */
  readonly vendorAuth?: VendorAuthService;
  readonly actor: string;
  readonly out: (line: string) => void;
}

/** Runs one command; returns the process exit code. */
export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  const { admin, actor, out } = context;
  const { positionals, values } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const [command] = positionals;
  if (command === undefined || values.help === true) {
    out(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  switch (command) {
    case 'tenant:create': {
      const tenant = await admin.createTenant(required(values, 'name'), actor);
      out(`Tenant ${tenant.id} created: ${tenant.name}`);
      return 0;
    }
    case 'installation:create': {
      const issued = await admin.createInstallation(
        {
          tenantId: required(values, 'tenant'),
          name: required(values, 'name'),
          ...(values.channel !== undefined && { channel: channelOf(values.channel) }),
        },
        actor,
      );
      out(`Installation ${issued.installationId} created.`);
      out(`Enrolment code (shown once): ${issued.code}`);
      out(`Valid until ${issued.expiresAt.toISOString()}.`);
      return 0;
    }
    case 'installation:code': {
      const issued = await admin.issueEnrolmentCode(required(values, 'installation'), actor);
      out(`Enrolment code (shown once): ${issued.code}`);
      out(`Valid until ${issued.expiresAt.toISOString()}.`);
      return 0;
    }
    case 'installation:revoke': {
      const id = required(values, 'installation');
      await admin.revokeInstallation(id, required(values, 'reason'), actor);
      out(`Installation ${id} revoked.`);
      return 0;
    }
    case 'installations:list': {
      for (const installation of await admin.listInstallations()) {
        out(
          [
            installation.id,
            installation.tenant,
            installation.name,
            installation.status,
            installation.channel,
            installation.version ?? '-',
            installation.lastSeenAt?.toISOString() ?? 'never',
          ].join('\t'),
        );
      }
      return 0;
    }
    case 'release:publish': {
      const size = Number(required(values, 'size'));
      const release = await admin.publishRelease(
        {
          component: componentOf(values.component),
          channel: channelOf(required(values, 'channel')) ?? 'STABLE',
          version: required(values, 'version'),
          url: required(values, 'url'),
          sha256: required(values, 'sha256'),
          sizeBytes: size,
          ...(typeof values.notes === 'string' && { notes: values.notes }),
          // UPD-006: the component version matrix the packaging step wrote.
          ...(typeof values.matrix === 'string' && {
            matrix: VersionMatrix.parse(JSON.parse(readFileSync(values.matrix, 'utf8'))),
          }),
        },
        actor,
      );
      out(`Published ${release.component} ${release.version} on ${release.channel}.`);
      return 0;
    }
    case 'vendor-user:create': {
      const { vendorAuth } = context;
      if (vendorAuth === undefined) throw new Error('Vendor accounts are not available here');
      const created = await vendorAuth.create(
        CreateVendorUserRequest.parse({
          email: required(values, 'email'),
          name: required(values, 'name'),
          role: required(values, 'role'),
        }),
        actor,
      );
      out(`Account ${created.user.id} created for ${created.user.email} (${created.user.role}).`);
      out(`Setup token (shown once; give it to the person directly): ${created.setupToken}`);
      out(`They open <Control Plane address>/setup#${created.setupToken} in a browser and set a`);
      out(`password and an authenticator before ${created.setupExpiresAt}.`);
      return 0;
    }
    case 'licence:show':
    case 'licence:set':
    case 'licence:rebind':
    case 'licence:code': {
      const { licences } = context;
      if (licences === undefined) throw new Error('Licences are not available here');
      const id = required(values, 'installation');
      if (command === 'licence:show') {
        printLicence(await licences.summary(id), out);
      } else if (command === 'licence:rebind') {
        printLicence(await licences.rebind(id, required(values, 'reason'), actor), out);
        out('The next licence binds the PC that asks for it.');
      } else if (command === 'licence:code') {
        const issued = await licences.reactivationCode(id, required(values, 'until'), actor);
        out(`Reactivation code (shown once, read it to the Owner): ${issued.code}`);
        out(`Active until the end of ${issued.validUntil} (code ${String(issued.counter)}).`);
      } else {
        const state = values.state === undefined ? undefined : LicenceState.parse(values.state);
        const validityDays = daysOf(values['validity-days'], 'validity-days');
        const graceDays = daysOf(values['grace-days'], 'grace-days');
        printLicence(
          await licences.change(
            id,
            {
              reason: required(values, 'reason'),
              ...(state !== undefined && { state }),
              ...(typeof values.plan === 'string' && { plan: values.plan }),
              ...(typeof values.limits === 'string' && { deviceLimits: limitsOf(values.limits) }),
              ...(validityDays !== undefined && { validityDays }),
              ...(graceDays !== undefined && { graceDays }),
            },
            actor,
          ),
          out,
        );
      }
      return 0;
    }
    default:
      out(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

async function main(): Promise<number> {
  const config = { ...loadConfig(), logLevel: 'warn' as const, logPretty: false };
  const app = await NestFactory.createApplicationContext(ControlPlaneModule.forRoot(config), {
    logger: false,
  });
  try {
    return await runCli(process.argv.slice(2), {
      admin: app.get(AdminService),
      licences: app.get(LicencesService),
      vendorAuth: app.get(VendorAuthService),
      actor: actorFrom(),
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    await app.close();
  }
}

// Run only as a program, not when tests import runCli.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
