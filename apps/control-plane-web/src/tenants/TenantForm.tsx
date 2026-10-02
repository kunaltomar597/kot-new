import { TenantRequest, type VendorTenantView } from '@rp/contracts/control-plane';
import { Button, Dialog, TextField } from '@rp/ui-web';
import { useState } from 'react';
import { useT } from '../app/i18n.js';
import { fieldErrors, messageOf } from '../app/messages.js';

type Field =
  'name' | 'legalName' | 'gstin' | 'stateCode' | 'contactName' | 'contactEmail' | 'contactPhone';
type Draft = Record<Field, string>;

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** The form's text as a request; empty optional fields are null, the state follows the GSTIN. */
export function tenantRequestOf(draft: Draft) {
  const gstin = blank(draft.gstin);
  const stateCode = blank(draft.stateCode) ?? (gstin === null ? null : gstin.slice(0, 2));
  return TenantRequest.safeParse({
    name: draft.name,
    legalName: blank(draft.legalName),
    gstin,
    stateCode,
    contactName: draft.contactName,
    contactEmail: blank(draft.contactEmail),
    contactPhone: blank(draft.contactPhone),
  });
}

function draftOf(tenant: VendorTenantView | undefined): Draft {
  return {
    name: tenant?.name ?? '',
    legalName: tenant?.legalName ?? '',
    gstin: tenant?.gstin ?? '',
    stateCode: tenant?.stateCode ?? '',
    contactName: tenant?.contactName ?? '',
    contactEmail: tenant?.contactEmail ?? '',
    contactPhone: tenant?.contactPhone ?? '',
  };
}

/** Adding or editing a restaurant: name, legal name, GSTIN, state and contact (VCP-002). */
export function TenantDialog({
  open,
  tenant,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The restaurant to edit; none to add one. */
  tenant?: VendorTenantView;
  onClose: () => void;
  onSave: (request: TenantRequest) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => draftOf(tenant));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const close = () => {
    setDraft(draftOf(tenant));
    setErrors({});
    setError(undefined);
    onClose();
  };
  const field = (name: Field, props: Partial<Parameters<typeof TextField>[0]> = {}) => (
    <TextField
      label={t(`vendorApp.tenant.field.${name}`)}
      value={draft[name]}
      error={errors[name]}
      onChange={(event) => {
        setDraft({ ...draft, [name]: event.target.value });
      }}
      {...props}
    />
  );
  return (
    <Dialog
      open={open}
      onClose={close}
      size="md"
      title={
        tenant === undefined ? t('vendorApp.tenant.addTitle') : t('vendorApp.tenant.editTitle')
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('vendorApp.actions.cancel')}
          </Button>
          <Button
            form="cp-tenant-form"
            type="submit"
            loading={busy}
            disabled={busy || draft.name.trim() === '' || draft.contactName.trim() === ''}
          >
            {t('vendorApp.actions.save')}
          </Button>
        </>
      }
    >
      <form
        id="cp-tenant-form"
        className="cp-form cp-form--grid"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = tenantRequestOf(draft);
          if (!parsed.success) {
            setErrors(fieldErrors(parsed.error));
            return;
          }
          setErrors({});
          setBusy(true);
          setError(undefined);
          onSave(parsed.data).then(
            () => {
              setBusy(false);
            },
            (failure: unknown) => {
              setBusy(false);
              setError(messageOf(failure, t));
            },
          );
        }}
      >
        {field('name', { maxLength: 120 })}
        {field('legalName', { maxLength: 200 })}
        {field('gstin', {
          maxLength: 15,
          autoCapitalize: 'characters',
          hint: t('vendorApp.tenant.gstinHint'),
        })}
        {field('stateCode', {
          maxLength: 2,
          inputMode: 'numeric',
          hint: t('vendorApp.tenant.stateHint'),
        })}
        {field('contactName', { maxLength: 120 })}
        {field('contactEmail', { type: 'email', maxLength: 200 })}
        {field('contactPhone', { type: 'tel', maxLength: 20 })}
      </form>
      {error === undefined ? null : (
        <p role="alert" className="cp-notice cp-notice--danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
