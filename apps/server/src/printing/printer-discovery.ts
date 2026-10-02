import { Inject, Injectable } from '@nestjs/common';
import type { PrinterDiscoveryResponse } from '@rp/contracts';
import { connect } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** How long one address may take to answer: a printer on the LAN answers in milliseconds. */
const PROBE_TIMEOUT_MS = 400;
/** Addresses looked at together, so a /24 takes about two seconds. */
const CONCURRENCY = 64;

/** Injection token for the `PrinterNetworks` the discovery looks at. */
export const PRINTER_NETWORKS = Symbol('PRINTER_NETWORKS');

/**
 * Where to look for network printers: every other address on the PC's own private IPv4 networks,
 * one /24 each at most (a wider network is cut to the PC's own /24, so a scan stays short and
 * local; a public address is never scanned).
 */
export interface PrinterNetworks {
  networks(): { readonly label: string; readonly hosts: readonly string[] }[];
}

/** The networks to look at for the PC's network interfaces (`os.networkInterfaces()`). */
export function networksOf(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): { label: string; hosts: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const own = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      // Private networks only (RFC 1918), cut to the PC's own /24.
      const [first = 0, second = 0] = own;
      const isPrivate =
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
      const prefix = own.slice(0, 3).join('.');
      if (!isPrivate || seen.has(prefix) || mask.length !== 4) continue;
      const lastMask = mask[3] ?? 0;
      const ownLast = own[3] ?? 0;
      const hosts: string[] = [];
      for (let last = 1; last < 255; last += 1) {
        if (last !== ownLast && (last & lastMask) === (ownLast & lastMask)) {
          hosts.push(`${prefix}.${String(last)}`);
        }
      }
      seen.set(prefix, hosts);
    }
  }
  return [...seen].map(([prefix, hosts]) => ({ label: `${prefix}.0/24`, hosts }));
}

export class LocalPrinterNetworks implements PrinterNetworks {
  networks() {
    return networksOf(networkInterfaces());
  }
}

/** Whether something answers on host:port within the timeout. */
export function probe(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/** Every host:port that answers, looking at several at a time; in the order given. */
export async function findOpenPorts(
  hosts: readonly string[],
  ports: readonly number[],
  answers: (host: string, port: number) => Promise<boolean> = probe,
): Promise<{ host: string; port: number }[]> {
  const targets = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
  const open = new Array<boolean>(targets.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next;
      next += 1;
      const target = targets[index];
      if (target !== undefined) open[index] = await answers(target.host, target.port);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return targets.filter((_, index) => open[index]);
}

/**
 * Finding receipt printers on the restaurant's network (ONB-004 step 6, S): the addresses of the
 * PC's own networks that answer on a printer port (`printers.discoveryPorts`). Only when a manager
 * asks; nothing is added or printed, and a printer already added says so.
 */
@Injectable()
export class PrinterDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(PRINTER_NETWORKS) private readonly local: PrinterNetworks,
  ) {}

  async discover(principal: Principal): Promise<PrinterDiscoveryResponse> {
    const settings = await this.settings.snapshot(principal.restaurantId);
    const ports = settings.get('printers.discoveryPorts');
    const networks = this.local.networks();
    const [found, known] = await Promise.all([
      findOpenPorts(
        networks.flatMap((network) => network.hosts),
        ports,
      ),
      this.prisma.printer.findMany({
        where: { restaurantId: principal.restaurantId, archivedAt: null, connection: 'NETWORK' },
        select: { id: true, name: true, host: true, port: true },
      }),
    ]);
    return {
      networks: networks.map((network) => network.label),
      printers: found.map(({ host, port }) => {
        const added = known.find((printer) => printer.host === host && printer.port === port);
        return {
          host,
          port,
          printerId: added?.id ?? null,
          printerName: added?.name ?? null,
        };
      }),
    };
  }
}
