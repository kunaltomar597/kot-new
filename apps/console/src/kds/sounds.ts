/**
 * The kitchen's sounds (KDS-009): a two-note chime for a new ticket, a lower double buzz for a
 * change or cancellation. Made with Web Audio, so nothing is downloaded. Browsers allow sound only
 * after a tap on the page, so the screen unlocks it on the first touch.
 */
export interface KitchenSounds {
  unlock(): void;
  newTicket(volumePercent: number): void;
  change(volumePercent: number): void;
}

/** "Here I am" when a manager looks for this device (MGR-006 "Locate"): three rising notes. */
export interface LocateSound {
  unlock(): void;
  locate(volumePercent: number): void;
}

type Note = readonly [frequencyHz: number, startSeconds: number, lengthSeconds: number];

const CHIME: readonly Note[] = [
  [880, 0, 0.18],
  [1320, 0.2, 0.28],
];
const BUZZ: readonly Note[] = [
  [330, 0, 0.22],
  [330, 0.3, 0.22],
];
const HERE: readonly Note[] = [
  [660, 0, 0.16],
  [880, 0.2, 0.16],
  [1175, 0.4, 0.32],
];

export function webAudioSounds(
  create: () => AudioContext = () => new AudioContext(),
): KitchenSounds & LocateSound {
  let context: AudioContext | undefined;
  const play = (notes: readonly Note[], volumePercent: number, wave: OscillatorType) => {
    if (context === undefined || volumePercent <= 0) return;
    const start = context.currentTime;
    for (const [frequency, at, length] of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = wave;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime((volumePercent / 100) * 0.4, start + at);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + at);
      oscillator.stop(start + at + length);
    }
  };
  return {
    unlock() {
      try {
        context ??= create();
        void context.resume();
      } catch {
        // No audio on this device: the screen still works, silently.
      }
    },
    newTicket(volumePercent) {
      play(CHIME, volumePercent, 'sine');
    },
    change(volumePercent) {
      play(BUZZ, volumePercent, 'square');
    },
    locate(volumePercent) {
      play(HERE, volumePercent, 'triangle');
    },
  };
}
