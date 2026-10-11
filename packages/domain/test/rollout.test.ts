import { describe, expect, it } from 'vitest';
import {
  haltReason,
  inRollout,
  releaseToOffer,
  type RolloutRelease,
  rolloutBucket,
} from '../src/rollout.js';

const pc = (n: number) => `0199a0e0-0000-7000-8000-${String(n).padStart(12, '0')}`;

function release(overrides: Partial<RolloutRelease> & { version: string }): RolloutRelease {
  return {
    id: `release-${overrides.version}`,
    percent: 100,
    state: 'ACTIVE',
    cohort: [],
    targetInstallationId: null,
    ...overrides,
  };
}

describe('[UPD-003] staged rollout', () => {
  it('gives each PC the same bucket every time, spread across 0 to 99', () => {
    expect(rolloutBucket(pc(1), 'r1')).toBe(rolloutBucket(pc(1), 'r1'));
    const buckets = Array.from({ length: 1_000 }, (_, index) => rolloutBucket(pc(index), 'r1'));
    expect(Math.min(...buckets)).toBe(0);
    expect(Math.max(...buckets)).toBe(99);
    // About a tenth of the fleet below 10.
    const first = buckets.filter((bucket) => bucket < 10).length;
    expect(first).toBeGreaterThan(60);
    expect(first).toBeLessThan(140);
  });

  it('keeps the PCs already reached when the rollout widens', () => {
    const ten = release({ version: '1.1.0', percent: 10 });
    const thirty = { ...ten, percent: 30 };
    const pcs = Array.from({ length: 300 }, (_, index) => pc(index));
    const reached = pcs.filter((id) => inRollout(ten, id));
    expect(reached.every((id) => inRollout(thirty, id))).toBe(true);
    expect(pcs.filter((id) => inRollout(thirty, id)).length).toBeGreaterThan(reached.length);
  });

  it('reaches the cohort whatever its bucket, and nobody while paused or halted', () => {
    const outside = Array.from({ length: 200 }, (_, index) => pc(index)).find(
      (id) => rolloutBucket(id, 'release-1.1.0') >= 5,
    );
    if (outside === undefined) throw new Error('No PC outside the first 5 %');
    const piloting = release({ version: '1.1.0', percent: 5, cohort: [outside] });
    expect(inRollout(piloting, outside)).toBe(true);
    expect(inRollout({ ...piloting, state: 'PAUSED' }, outside)).toBe(false);
    expect(inRollout({ ...piloting, state: 'HALTED' }, outside)).toBe(false);
  });
});

describe('[UPD-002] what a PC is offered', () => {
  const me = { id: pc(7), version: '1.0.0', pinnedVersion: null };

  it('offers the newest release the rollout reaches, and never an older one', () => {
    const releases = [
      release({ version: '1.1.0' }),
      release({ version: '1.2.0' }),
      release({ version: '0.9.0' }),
    ];
    expect(releaseToOffer(me, releases)?.version).toBe('1.2.0');
    expect(releaseToOffer({ ...me, version: '1.2.0' }, releases)).toBeUndefined();
    expect(releaseToOffer({ ...me, version: 'dev' }, releases)).toBeUndefined();
    // 1.2.0 is not out to this PC yet: the newest it is reached by.
    expect(
      releaseToOffer(me, [release({ version: '1.1.0' }), release({ version: '1.2.0', percent: 0 })])
        ?.version,
    ).toBe('1.1.0');
  });

  it('holds a PC at its version: that version whatever the rollout, nothing newer', () => {
    const held = { ...me, pinnedVersion: '1.1.0' };
    const releases = [release({ version: '1.1.0', percent: 0 }), release({ version: '1.2.0' })];
    expect(releaseToOffer(held, releases)?.version).toBe('1.1.0');
    expect(releaseToOffer({ ...held, version: '1.1.0' }, releases)).toBeUndefined();
    // Not even a held version once it was halted.
    expect(releaseToOffer(held, [release({ version: '1.1.0', state: 'HALTED' })])).toBeUndefined();
  });

  it('gives a hotfix to its PC only, before the channel', () => {
    const releases = [
      release({ version: '1.2.0' }),
      release({ version: '1.1.1-hotfix.1', targetInstallationId: me.id }),
      release({ version: '1.3.0-hotfix.1', targetInstallationId: pc(8) }),
    ];
    expect(releaseToOffer(me, releases)?.version).toBe('1.1.1-hotfix.1');
    expect(releaseToOffer({ ...me, id: pc(9) }, releases)?.version).toBe('1.2.0');
  });
});

describe('[UPD-003] halting a rollout by itself', () => {
  it('halts when enough of the PCs that installed it fail or spike', () => {
    expect(haltReason({ attempts: 10, failures: 1, errorSpikes: 0 })).toBeUndefined();
    expect(haltReason({ attempts: 20, failures: 2, errorSpikes: 1 })).toBeUndefined();
    expect(haltReason({ attempts: 10, failures: 1, errorSpikes: 1 })).toBe(
      'Halted automatically: 1 failed or rolled back and 1 with an error spike, of 10 PCs that installed it.',
    );
    expect(haltReason({ attempts: 2, failures: 2, errorSpikes: 0 })).toMatch(/2 failed/);
    expect(haltReason({ attempts: 0, failures: 0, errorSpikes: 0 })).toBeUndefined();
  });
});
