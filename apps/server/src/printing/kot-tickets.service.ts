import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { Printer } from '../generated/prisma/client.js';
import { type KotTicket, type PaperWidthMm, paperWidthOf, renderKotTicket } from './escpos.js';

export interface RenderedKot {
  readonly ticket: KotTicket;
  /** The station's printer, or null for a screen-only station or one without a printer. */
  readonly printer: Printer | null;
  /** ESC/POS bytes for the station's printer (80 mm when there is none). */
  readonly bytes: Uint8Array;
}

/**
 * Builds the printed form of a KOT from what was stored when it was raised (P1-07a, ORD-007,
 * KDS-008): names, variants and modifiers are the ones on the order, never today's menu. The print
 * queue (P1-07b) sends the bytes; a reprint on another printer renders for that printer's paper.
 */
@Injectable()
export class KotTicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async render(
    restaurantId: string,
    kotId: string,
    options: { reprint?: boolean; paperWidthMm?: PaperWidthMm } = {},
  ): Promise<RenderedKot> {
    const kot = await this.prisma.kot.findFirst({
      where: { id: kotId, restaurantId },
      include: {
        station: { include: { printer: true } },
        order: {
          include: {
            table: { select: { label: true } },
            tableSession: { select: { waiterId: true } },
          },
        },
        lines: {
          orderBy: { createdAt: 'asc' },
          include: {
            orderItem: {
              include: {
                modifiers: { orderBy: { createdAt: 'asc' } },
                parent: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (kot === null) throw new AppError(404, 'KOT_NOT_FOUND', 'There is no such ticket.');

    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { timeZone: true },
    });
    const waiterId = kot.order.tableSession?.waiterId ?? kot.order.createdById;
    const waiter =
      waiterId === null
        ? null
        : await this.prisma.staff.findFirst({
            where: { id: waiterId, restaurantId },
            select: { displayName: true },
          });

    const ticket: KotTicket = {
      kind: kot.kind,
      kotNumber: kot.kotNumber,
      orderNumber: kot.order.orderNumber,
      stationName: kot.station.name,
      destination:
        kot.order.table === null
          ? { type: 'TAKEAWAY', token: kot.order.takeawayToken }
          : { type: 'TABLE', label: kot.order.table.label },
      waiterName: waiter?.displayName ?? null,
      source: kot.order.source,
      createdAt: kot.createdAt,
      timeZone: restaurant.timeZone,
      reprint: options.reprint ?? false,
      lines: kot.lines.map((line) => ({
        quantity: line.quantity,
        name: line.orderItem.name,
        variantName: line.orderItem.variantName,
        modifiers: line.orderItem.modifiers.map((modifier) => ({
          name: modifier.name,
          quantity: modifier.quantity,
        })),
        instructions: line.orderItem.instructions,
        comboName: line.orderItem.parent?.name ?? null,
      })),
    };
    const printer = kot.station.mode === 'SCREEN' ? null : kot.station.printer;
    const paperWidthMm = options.paperWidthMm ?? (printer === null ? 80 : paperWidthOf(printer));
    return { ticket, printer, bytes: renderKotTicket(ticket, paperWidthMm) };
  }
}
