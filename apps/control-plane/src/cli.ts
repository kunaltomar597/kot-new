import 'reflect-metadata';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { RELEASE_CHANNELS, type ReleaseChannel } from '@rp/contracts/control-plane';
import { AdminService } from './admin/admin.service.js';
import { ControlPlaneModule } from './app.module.js';
import { loadConfig } from './config/cp-config.js';
import { CpError } from './errors/cp-error.js';

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

export interface CliContext {
  readonly admin: AdminService;
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
          component: 'RESTAURANT_PC',
          channel: channelOf(required(values, 'channel')) ?? 'STABLE',
          version: required(values, 'version'),
          url: required(values, 'url'),
          sha256: required(values, 'sha256'),
          sizeBytes: size,
          ...(typeof values.notes === 'string' && { notes: values.notes }),
        },
        actor,
      );
      out(`Published ${release.component} ${release.version} on ${release.channel}.`);
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
