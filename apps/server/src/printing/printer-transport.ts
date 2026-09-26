import { writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { NETWORK_HOST, USB_DEVICE, USB_SHARE } from '@rp/contracts';

/** Where a job goes: a network printer's raw port, or a USB printer on the server PC. */
export interface PrintTarget {
  readonly connection: 'NETWORK' | 'USB';
  readonly host: string;
  readonly port: number | null;
}

/** Why a job did not print, in words a manager can act on (NFR-U04). */
export class PrintFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PrintFailure';
  }
}

/** Sends rendered ESC/POS bytes to a printer. Replaced in tests that must not touch a device. */
export abstract class PrinterTransport {
  abstract send(target: PrintTarget, bytes: Uint8Array): Promise<void>;
}

/** Long enough for a busy printer on Wi-Fi, short enough that the POS hears about a dead one. */
const NETWORK_TIMEOUT_MS = 5_000;

function networkErrorMessage(error: NodeJS.ErrnoException, target: string): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return `The printer at ${target} refused the connection. Check that it is on and that the port is right (usually 9100).`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `No printer answers at ${target}. Check its IP address and that it is on the restaurant network.`;
    default:
      return `Printing to ${target} failed (${error.code ?? error.message}). Check the printer and its cable or Wi-Fi.`;
  }
}

/**
 * The real transport (P1-07a, KDS-008). Network printers take raw ESC/POS on a TCP port (9100 on
 * almost every model). A USB printer is shared under a name on the Windows server PC and written
 * to as `\\localhost\<share>`, which Windows sends to the printer unchanged; on Linux a
 * `/dev/usb/lpN` device takes the same bytes. Host values are checked again here, so nothing but a
 * printer is ever written to.
 */
export class NetworkAndUsbTransport extends PrinterTransport {
  constructor(private readonly timeoutMs: number = NETWORK_TIMEOUT_MS) {
    super();
  }

  send(target: PrintTarget, bytes: Uint8Array): Promise<void> {
    return target.connection === 'NETWORK'
      ? this.sendToNetwork(target, bytes)
      : this.sendToUsb(target, bytes);
  }

  private sendToNetwork(target: PrintTarget, bytes: Uint8Array): Promise<void> {
    if (!NETWORK_HOST.test(target.host) || target.port === null) {
      return Promise.reject(new PrintFailure('The printer has no valid address and port.'));
    }
    const port = target.port;
    const where = `${target.host}:${String(port)}`;
    return new Promise((resolve, reject) => {
      const socket = connect({ host: target.host, port });
      let settled = false;
      const fail = (message: string, cause?: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new PrintFailure(message, { cause }));
      };
      socket.setTimeout(this.timeoutMs, () => {
        fail(`The printer at ${where} did not answer in time. Check that it is on and has paper.`);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        fail(networkErrorMessage(error, where), error);
      });
      socket.once('connect', () => {
        socket.end(bytes, () => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve();
        });
      });
    });
  }

  private async sendToUsb(target: PrintTarget, bytes: Uint8Array): Promise<void> {
    let path: string;
    if (process.platform === 'win32' && USB_SHARE.test(target.host)) {
      path = `\\\\localhost\\${target.host}`;
    } else if (process.platform !== 'win32' && USB_DEVICE.test(target.host)) {
      path = target.host;
    } else {
      throw new PrintFailure(
        process.platform === 'win32'
          ? 'Share the USB printer in Windows and enter its share name.'
          : 'Enter the USB printer device, for example /dev/usb/lp0.',
      );
    }
    try {
      await writeFile(path, bytes);
    } catch (error) {
      throw new PrintFailure(
        `The USB printer "${target.host}" did not take the page. Check that it is on, connected and shared.`,
        { cause: error },
      );
    }
  }
}
