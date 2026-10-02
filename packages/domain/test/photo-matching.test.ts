import { describe, expect, it } from 'vitest';
import { matchPhotos, type PhotoCandidate, photoWords } from '../src/index.js';

const ITEMS: PhotoCandidate[] = [
  { id: 'tikka', name: 'Paneer Tikka', shortCode: 'PT-01' },
  { id: 'tikka-masala', name: 'Paneer Tikka Masala', shortCode: null },
  { id: 'dal', name: 'Dal Makhani', shortCode: 'DM' },
  { id: 'naan', name: 'Butter Naan', shortCode: null },
  { id: 'garlic', name: 'Garlic Naan', shortCode: null },
  { id: 'creme', name: 'Crème Brûlée', shortCode: null },
];

const matched = (files: string[]) =>
  matchPhotos(files, ITEMS).map((match) => [match.file, match.itemId, match.by]);

describe('[ONB-007] matching bulk photos to dishes by file name or code', () => {
  it('reads file names the way people save them', () => {
    expect(photoWords('Paneer_Tikka-2')).toBe('paneer tikka 2');
    expect(photoWords('  Crème  Brûlée ')).toBe('creme brulee');
  });

  it('matches by short code first, then by name', () => {
    expect(
      matched([
        'PT-01.jpg',
        'dm photo.png',
        'Butter Naan.jpeg',
        'menu/garlic_naan_final.webp',
        'creme-brulee.jpg',
      ]),
    ).toEqual([
      ['PT-01.jpg', 'tikka', 'CODE'],
      ['dm photo.png', 'dal', 'CODE'],
      ['Butter Naan.jpeg', 'naan', 'NAME'],
      ['menu/garlic_naan_final.webp', 'garlic', 'NAME'],
      ['creme-brulee.jpg', 'creme', 'NAME'],
    ]);
  });

  it('takes the longest dish name in the file name', () => {
    expect(matched(['paneer tikka masala 1.jpg'])).toEqual([
      ['paneer tikka masala 1.jpg', 'tikka-masala', 'NAME'],
    ]);
  });

  it('leaves for a person what is unclear or taken already', () => {
    expect(
      matched(['IMG_2024.jpg', 'naan.jpg', 'Paneer Tikka.jpg', 'paneer-tikka-again.jpg', '.jpg']),
    ).toEqual([
      ['IMG_2024.jpg', null, null],
      // Butter or garlic: not for a guess.
      ['naan.jpg', null, null],
      ['Paneer Tikka.jpg', 'tikka', 'NAME'],
      ['paneer-tikka-again.jpg', null, null],
      ['.jpg', null, null],
    ]);
  });
});
