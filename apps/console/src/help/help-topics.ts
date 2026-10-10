/**
 * Contextual help and first-use tips (NFR-U07). Every dashboard page has a help topic: a short
 * explanation behind a "Help" button, shown once by itself the first time a person opens the page.
 * What a person has seen is kept per person on this device (not secret, never sent anywhere).
 */
export const HELP_TOPICS = [
  'overview',
  'orders',
  'alerts',
  'reports',
  'audit',
  'staff',
  'floor',
  'qrCodes',
  'menu',
  'devices',
  'setup',
  'restaurant',
  'printing',
  'settings',
  'system',
  'licence',
  'security',
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

const PATH_TOPICS: Readonly<Record<string, HelpTopic>> = {
  '': 'overview',
  orders: 'orders',
  alerts: 'alerts',
  reports: 'reports',
  archives: 'reports',
  audit: 'audit',
  staff: 'staff',
  floor: 'floor',
  'qr-codes': 'qrCodes',
  menu: 'menu',
  devices: 'devices',
  setup: 'setup',
  restaurant: 'restaurant',
  printing: 'printing',
  settings: 'settings',
  system: 'system',
  licence: 'licence',
  security: 'security',
};

/** The topic of a dashboard path such as `/manage/menu/photos`, or none for an unknown page. */
export function topicForPath(pathname: string): HelpTopic | undefined {
  const match = /^\/manage\/?([^/]*)/.exec(pathname);
  return match === null ? undefined : PATH_TOPICS[match[1] ?? ''];
}

const KEY_PREFIX = 'rp-console.tips-seen.';

/** The topics this person has already been shown on their own. */
export function seenTopics(storage: Pick<Storage, 'getItem'>, personId: string): Set<HelpTopic> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY_PREFIX + personId) ?? '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(HELP_TOPICS.filter((topic) => parsed.includes(topic)));
  } catch {
    return new Set();
  }
}

/** Remembers that the person has been shown a topic. Storage that is blocked or full is ignored. */
export function markSeen(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  personId: string,
  topic: HelpTopic,
): void {
  const seen = seenTopics(storage, personId).add(topic);
  try {
    storage.setItem(KEY_PREFIX + personId, JSON.stringify([...seen]));
  } catch {
    // The tip shows again next time; nothing else depends on it.
  }
}
