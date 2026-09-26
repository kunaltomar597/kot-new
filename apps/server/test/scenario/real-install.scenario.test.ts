import { serviceDaySuite } from './service-day-suite.js';

/**
 * The Phase 1 exit scenario against a real install, for the lab rig (P1-14). It closes that
 * install's business day, so use a test restaurant. Skipped unless RP_SCENARIO_URL is set:
 *
 *   RP_SCENARIO_URL=https://pos.local:8443 \
 *   RP_SCENARIO_PAIRING_CODES=CODE1,CODE2 \
 *   RP_SCENARIO_MANAGER="Vikram (Manager)" RP_SCENARIO_MANAGER_PIN=... \
 *   RP_SCENARIO_CASHIER="Neha (Cashier)" RP_SCENARIO_CASHIER_PIN=... \
 *   NODE_EXTRA_CA_CERTS=restaurant-ca.pem \
 *   pnpm --filter @rp/server scenario:service-day
 *
 * The pairing codes are two POS codes from Manage → Devices. The install's CA must be trusted
 * (download it from /api/v1/tls/ca). No database or PostgreSQL is needed on the machine running it.
 */
const url = process.env.RP_SCENARIO_URL;

serviceDaySuite(() => {
  const [first, second] = (process.env.RP_SCENARIO_PAIRING_CODES ?? '').split(',');
  if (url === undefined || first === undefined || second === undefined) {
    throw new Error('Set RP_SCENARIO_URL and RP_SCENARIO_PAIRING_CODES (two POS codes)');
  }
  return {
    baseUrl: url,
    pairingCodes: [first.trim(), second.trim()],
    manager: {
      name: process.env.RP_SCENARIO_MANAGER ?? '',
      pin: process.env.RP_SCENARIO_MANAGER_PIN ?? '',
    },
    cashier: {
      name: process.env.RP_SCENARIO_CASHIER ?? '',
      pin: process.env.RP_SCENARIO_CASHIER_PIN ?? '',
    },
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}, url === undefined);
