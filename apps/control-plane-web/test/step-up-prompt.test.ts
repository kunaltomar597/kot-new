import { describe, expect, it } from 'vitest';
import { StepUpPrompt } from '../src/app/step-up.js';

describe('[SEC-018] the authenticator question (CP-S2)', () => {
  it('opens on a question and closes with the answer', async () => {
    const prompt = new StepUpPrompt();
    const asked = prompt.ask();
    expect(prompt.isOpen()).toBe(true);
    prompt.answer('123456');
    expect(await asked).toBe('123456');
    expect(prompt.isOpen()).toBe(false);
  });

  it('cancels the first question when a second comes', async () => {
    const prompt = new StepUpPrompt();
    const first = prompt.ask();
    const second = prompt.ask();
    expect(await first).toBeUndefined();
    prompt.answer('000000');
    expect(await second).toBe('000000');
  });
});
