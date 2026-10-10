import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import type { TransactionClient } from '../../src/database/prisma.service.js';

describe('[SEC-015] [VCP-001] the audit log copy for the host (CP-T5)', () => {
  it('writes each entry to the log as well as the table, with its actor, action and target', async () => {
    const create = vi.fn(() => Promise.resolve({}));
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new AuditService().record({ auditEntry: { create } } as unknown as TransactionClient, {
      actor: 'vendor:1',
      action: 'release.published',
      targetType: 'release',
      targetId: 'r1',
      details: { version: '1.2.3' },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith({
      event: 'audit',
      actor: 'vendor:1',
      action: 'release.published',
      targetType: 'release',
      targetId: 'r1',
      details: { version: '1.2.3' },
    });
    log.mockRestore();
  });
});
