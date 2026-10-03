import { GO_LIVE_PATHS, ONBOARDING_STEPS } from '@rp/domain';
import { z } from 'zod';
import { Pin } from './auth.js';
import { Id, Timestamp } from './common.js';

/**
 * The first-run setup (ONB-004, P7-07): each step's status and the PC's activation (ONB-003).
 * Statuses come from what the restaurant has set up, so the setup resumes wherever it stopped.
 */

export const OnboardingStep = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const OnboardingStepView = z.object({
  step: OnboardingStep,
  status: z.enum(['DONE', 'SKIPPED', 'TODO']),
  /** The data is in place (a confirmed step still needs its confirmation). */
  ready: z.boolean(),
  /** May be confirmed by a person (the invoice look, the go-live test). */
  confirmable: z.boolean(),
  skippable: z.boolean(),
});
export type OnboardingStepView = z.infer<typeof OnboardingStepView>;

export const OnboardingResponse = z.object({
  steps: z.array(OnboardingStepView),
  complete: z.boolean(),
  activation: z.object({
    /** This PC knows the vendor's Control Plane address (set by the installer). */
    configured: z.boolean(),
    activated: z.boolean(),
    /** The name the vendor gave this PC, once activated. */
    installationName: z.string().nullable(),
  }),
});
export type OnboardingResponse = z.infer<typeof OnboardingResponse>;

export const OnboardingStepParams = z.strictObject({ step: OnboardingStep });
export type OnboardingStepParams = z.infer<typeof OnboardingStepParams>;

/** Confirm or skip a step, or take the mark back (TODO). */
export const MarkOnboardingStepRequest = z.strictObject({
  status: z.enum(['DONE', 'SKIPPED', 'TODO']),
});
export type MarkOnboardingStepRequest = z.infer<typeof MarkOnboardingStepRequest>;

/** The one-time activation code from the vendor (ONB-003), as people type it. */
export const ActivateRequest = z.strictObject({ code: z.string().trim().min(16).max(40) });
export type ActivateRequest = z.infer<typeof ActivateRequest>;

export const ActivateResponse = z.object({
  installationId: Id,
  installationName: z.string(),
});
export type ActivateResponse = z.infer<typeof ActivateResponse>;

/**
 * Whether this server has no restaurant yet (a fresh install, ONB-001), and how many digits the
 * Owner's PIN has (`auth.pinLength`, 4 until the Owner changes it); nothing else.
 */
export const FirstRunStatus = z.object({ needed: z.boolean(), pinLength: z.int().min(4).max(8) });
export type FirstRunStatus = z.infer<typeof FirstRunStatus>;

/** The restaurant's name and its Owner, entered on the restaurant PC itself (P7-07b). */
export const FirstRunRequest = z.strictObject({
  restaurantName: z.string().trim().min(1).max(60),
  ownerName: z.string().trim().min(1).max(80),
  ownerPin: Pin,
});
export type FirstRunRequest = z.infer<typeof FirstRunRequest>;

export const FirstRunResponse = z.object({ restaurantId: Id, ownerId: Id });
export type FirstRunResponse = z.infer<typeof FirstRunResponse>;

export const GoLivePath = z.enum(GO_LIVE_PATHS);
export type GoLivePath = z.infer<typeof GoLivePath>;

/** The guided go-live test (ONB-004 step 11): each path ticked as the server sees it happen. */
export const GoLiveView = z.object({
  startedAt: Timestamp.nullable(),
  paths: z.array(
    z.object({
      path: GoLivePath,
      /** The restaurant uses it (it has the devices or QR ordering). */
      needed: z.boolean(),
      seenAt: Timestamp.nullable(),
    }),
  ),
  passed: z.boolean(),
});
export type GoLiveView = z.infer<typeof GoLiveView>;

/** The restaurant's settings, to move to a new PC or a reinstall (ONB-010). */
export const SettingsExport = z.object({
  format: z.literal(1),
  exportedAt: Timestamp,
  restaurantName: z.string(),
  /** Settings changed from their default, by key. */
  values: z.record(z.string().max(80), z.unknown()),
});
export type SettingsExport = z.infer<typeof SettingsExport>;

export const SettingsImportResponse = z.object({
  applied: z.array(z.string()),
  /** Keys left as they were, and why. */
  skipped: z.array(
    z.object({
      key: z.string(),
      reason: z.enum(['UNKNOWN', 'VENDOR', 'INVALID', 'NOT_ALLOWED', 'UNCHANGED']),
    }),
  ),
});
export type SettingsImportResponse = z.infer<typeof SettingsImportResponse>;
