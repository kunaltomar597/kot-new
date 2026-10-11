import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// A PC's page loads seven things at once; on a busy machine that takes more than the default
// 1 s that `findBy…` waits. Passing tests are not slower for it.
configure({ asyncUtilTimeout: 5_000 });

// jsdom has no HTMLDialogElement.showModal/close yet. This shim covers what the Dialog component
// relies on (the `open` state and the `close` event); focus trapping and inertness are the
// browser's job and are checked in the workbench in Chromium.
const hasDom = typeof HTMLDialogElement !== 'undefined';
if (
  hasDom &&
  typeof (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal !== 'function'
) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
