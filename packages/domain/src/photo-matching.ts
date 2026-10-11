/**
 * Bulk photo upload (P6-04c, ONB-007): which dish each photo is for, from its file name. A short
 * code wins ("PT01.jpg", "pt-01 tikka.jpg"), then the dish's name ("Paneer Tikka.jpg",
 * "paneer_tikka_2.jpeg"), then the longest dish name found in the file name. Ties and dishes
 * already taken by an earlier photo are left for the person to choose.
 */

export interface PhotoCandidate {
  readonly id: string;
  readonly name: string;
  readonly shortCode: string | null;
}

export interface PhotoMatch {
  readonly file: string;
  readonly itemId: string | null;
  /** How it was matched; null when it was not. */
  readonly by: 'CODE' | 'NAME' | null;
}

/** Lower case, accents and punctuation gone, words separated by single spaces. */
export function photoWords(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A file's name without its folder or extension. */
function baseName(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function matchOne(
  file: string,
  items: readonly PhotoCandidate[],
): { itemId: string; by: 'CODE' | 'NAME' } | undefined {
  const words = photoWords(baseName(file));
  if (words === '') return undefined;
  const padded = ` ${words} `;
  const byCode = items.filter((item) => {
    const code = item.shortCode === null ? '' : photoWords(item.shortCode);
    return code !== '' && (words === code || words.startsWith(`${code} `));
  });
  if (byCode.length === 1 && byCode[0] !== undefined) return { itemId: byCode[0].id, by: 'CODE' };
  const exact = items.filter((item) => photoWords(item.name) === words);
  if (exact.length === 1 && exact[0] !== undefined) return { itemId: exact[0].id, by: 'NAME' };
  const contained = items
    .map((item) => ({ item, name: photoWords(item.name) }))
    .filter(({ name }) => name !== '' && padded.includes(` ${name} `))
    .sort((a, b) => b.name.length - a.name.length);
  const [best, next] = contained;
  if (best === undefined || next?.name.length === best.name.length) return undefined;
  return { itemId: best.item.id, by: 'NAME' };
}

/** Each photo's dish, in the order given; a dish goes to the first photo that matches it. */
export function matchPhotos(
  files: readonly string[],
  items: readonly PhotoCandidate[],
): PhotoMatch[] {
  const taken = new Set<string>();
  return files.map((file) => {
    const match = matchOne(file, items);
    if (match === undefined || taken.has(match.itemId)) return { file, itemId: null, by: null };
    taken.add(match.itemId);
    return { file, itemId: match.itemId, by: match.by };
  });
}
