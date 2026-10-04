import type {
  FleetInstallationView,
  RolloutState,
  VendorReleaseView,
} from '@rp/contracts/control-plane';
import { ChoiceGroup, Select, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../app/i18n.js';
import { ReasonDialog } from '../components/ReasonDialog.js';
import { percentOf } from './release-view.js';

const STATES: readonly RolloutState[] = ['ACTIVE', 'PAUSED', 'HALTED'];

/**
 * A release's rollout (UPD-003): the share of the channel's PCs, the pilot PCs that get it
 * whatever the share, and whether it goes on, waits or is halted. Audited with the reason.
 */
export function RolloutDialog({
  release,
  pcs,
  onClose,
  onSave,
}: {
  release: VendorReleaseView;
  /** The channel's PCs, for the cohort. */
  pcs: readonly FleetInstallationView[];
  onClose: () => void;
  onSave: (rollout: {
    percent: number;
    state: RolloutState;
    cohort: string[];
    reason: string;
  }) => Promise<void>;
}) {
  const t = useT();
  const [percent, setPercent] = useState(String(release.rollout.percent));
  const [state, setState] = useState<RolloutState>(release.rollout.state);
  const [cohort, setCohort] = useState<string[]>(release.rollout.cohort.map((pc) => pc.id));
  const share = percentOf(percent);
  return (
    <ReasonDialog
      open
      title={t('vendorApp.releases.rolloutTitle', { version: release.version })}
      description={t('vendorApp.releases.rolloutIntro')}
      confirmLabel={t('vendorApp.actions.save')}
      tone={state === 'HALTED' ? 'danger' : 'primary'}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (share === undefined) throw new Error(t('vendorApp.releases.percentInvalid'));
        await onSave({ percent: share, state, cohort, reason });
      }}
    >
      <div className="cp-form">
        <TextField
          label={t('vendorApp.releases.percent')}
          hint={t('vendorApp.releases.percentHint')}
          inputMode="numeric"
          value={percent}
          error={share === undefined ? t('vendorApp.releases.percentInvalid') : undefined}
          onChange={(event) => {
            setPercent(event.target.value);
          }}
        />
        <Select
          label={t('vendorApp.releases.stateLabel')}
          value={state}
          options={STATES.map((value) => ({
            value,
            label: t(`vendorApp.releases.stateName.${value}`),
          }))}
          onChange={(event) => {
            setState(event.target.value as RolloutState);
          }}
        />
        {pcs.length === 0 ? null : (
          <ChoiceGroup
            legend={t('vendorApp.releases.cohort')}
            hint={t('vendorApp.releases.cohortHint')}
            mode="multiple"
            options={pcs.map((pc) => ({
              id: pc.installationId,
              label: t('vendorApp.releases.pcName', {
                pc: pc.installationName,
                tenant: pc.tenantName,
              }),
            }))}
            value={cohort}
            onChange={setCohort}
          />
        )}
      </div>
    </ReasonDialog>
  );
}
