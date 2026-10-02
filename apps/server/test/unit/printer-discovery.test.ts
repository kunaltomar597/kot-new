import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { findOpenPorts, networksOf } from '../../src/printing/printer-discovery.js';

const nic = (address: string, netmask: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask,
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: null,
});

describe('[ONB-004] where to look for network printers', () => {
  it('looks at the PC’s own private /24, never itself, the loopback or a public network', () => {
    const [lan, ...others] = networksOf({
      en0: [nic('192.168.1.20', '255.255.255.0')],
      lo0: [nic('127.0.0.1', '255.0.0.0', true)],
      wan: [nic('49.36.10.5', '255.255.255.0')],
    });
    expect(others).toEqual([]);
    expect(lan?.label).toBe('192.168.1.0/24');
    expect(lan?.hosts).toHaveLength(253);
    expect(lan?.hosts).not.toContain('192.168.1.20');
    expect(lan?.hosts[0]).toBe('192.168.1.1');
  });

  it('cuts a wide network to the PC’s /24, and keeps a narrow one to its mask', () => {
    expect(networksOf({ en0: [nic('10.0.5.7', '255.255.0.0')] })[0]?.hosts).toHaveLength(253);
    const narrow = networksOf({ en0: [nic('172.16.0.130', '255.255.255.128')] })[0];
    expect(narrow?.hosts).toHaveLength(126);
    expect(narrow?.hosts[0]).toBe('172.16.0.128');
  });
});

describe('[ONB-004] finding open printer ports', () => {
  it('keeps every host and port that answers, in order, looking at many at once', async () => {
    let busiest = 0;
    let busy = 0;
    const answers = async (host: string, port: number) => {
      busy += 1;
      busiest = Math.max(busiest, busy);
      await new Promise((resolve) => setTimeout(resolve, 1));
      busy -= 1;
      return host.endsWith('7') && port === 9100;
    };
    const hosts = Array.from({ length: 200 }, (_, index) => `10.0.0.${String(index + 1)}`);
    expect(await findOpenPorts(hosts, [9100, 9101], answers)).toEqual([
      { host: '10.0.0.7', port: 9100 },
      { host: '10.0.0.17', port: 9100 },
      { host: '10.0.0.27', port: 9100 },
      { host: '10.0.0.37', port: 9100 },
      { host: '10.0.0.47', port: 9100 },
      { host: '10.0.0.57', port: 9100 },
      { host: '10.0.0.67', port: 9100 },
      { host: '10.0.0.77', port: 9100 },
      { host: '10.0.0.87', port: 9100 },
      { host: '10.0.0.97', port: 9100 },
      { host: '10.0.0.107', port: 9100 },
      { host: '10.0.0.117', port: 9100 },
      { host: '10.0.0.127', port: 9100 },
      { host: '10.0.0.137', port: 9100 },
      { host: '10.0.0.147', port: 9100 },
      { host: '10.0.0.157', port: 9100 },
      { host: '10.0.0.167', port: 9100 },
      { host: '10.0.0.177', port: 9100 },
      { host: '10.0.0.187', port: 9100 },
      { host: '10.0.0.197', port: 9100 },
    ]);
    expect(busiest).toBe(64);
  });
});
