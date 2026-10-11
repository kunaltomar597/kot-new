import { MemoryStore } from '@rp/mobile-core';
import type { NewCartLine } from '@rp/ordering';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { CART_KEY, useCart } from '../src/use-cart';

const DAL = '0199a0e0-0000-7000-8000-000000000011';
const TIKKA = '0199a0e0-0000-7000-8000-000000000010';

function line(itemId: string, name: string): NewCartLine {
  return {
    itemId,
    name,
    summary: '',
    quantity: 1,
    selection: {},
    instructions: '',
    unitPrice: 24_000,
  };
}

async function savedLines(store: MemoryStore): Promise<unknown> {
  return JSON.parse((await store.getItem(CART_KEY)) ?? 'null');
}

describe('[TAB-008] the diners’ cart on the tablet', () => {
  it('keeps what the guests add, change and remove across a restart', async () => {
    const store = new MemoryStore();
    const { result } = await renderHook(() => useCart(store, 1));
    await act(() => {
      result.current.add(line(DAL, 'Dal Makhani'));
      result.current.add(line(TIKKA, 'Paneer Tikka'));
    });
    expect(result.current.lines.map((cartLine) => cartLine.name)).toEqual([
      'Dal Makhani',
      'Paneer Tikka',
    ]);
    const [dal, tikka] = result.current.lines;
    await act(() => {
      result.current.setQuantity(dal?.clientLineId ?? '', 3);
    });
    expect(result.current.lines[0]?.quantity).toBe(3);
    await act(() => {
      result.current.remove(tikka?.clientLineId ?? '');
    });
    expect(result.current.lines).toHaveLength(1);
    await waitFor(async () => {
      expect(await savedLines(store)).toEqual([
        expect.objectContaining({ itemId: DAL, quantity: 3 }),
      ]);
    });

    // The app restarts: the cart comes back from the tablet's storage.
    const restarted = await renderHook(() => useCart(store, 1));
    await waitFor(() => {
      expect(restarted.result.current.lines).toEqual([
        expect.objectContaining({ itemId: DAL, quantity: 3 }),
      ]);
    });
  });

  it('removes a line taken down to nothing, marks refused lines and clears after sending', async () => {
    const store = new MemoryStore();
    const { result } = await renderHook(() => useCart(store, 1));
    await act(() => {
      result.current.add(line(DAL, 'Dal Makhani'));
      result.current.add(line(TIKKA, 'Paneer Tikka'));
    });
    const [dal, tikka] = result.current.lines;
    await act(() => {
      result.current.setQuantity(dal?.clientLineId ?? '', 0);
    });
    expect(result.current.lines.map((cartLine) => cartLine.itemId)).toEqual([TIKKA]);
    await act(() => {
      result.current.rejected([
        { clientLineId: tikka?.clientLineId ?? '', message: 'Paneer Tikka is sold out' },
      ]);
    });
    expect(result.current.lines[0]?.error).toBe('Paneer Tikka is sold out');
    await act(() => {
      result.current.clear();
    });
    expect(result.current.lines).toEqual([]);
  });

  it('starts empty from nothing stored or something unreadable, keeping only real lines', async () => {
    const store = new MemoryStore();
    await store.setItem(
      CART_KEY,
      JSON.stringify([{ clientLineId: 'a', itemId: DAL, quantity: 1 }, { itemId: 'broken' }, 7]),
    );
    const kept = await renderHook(() => useCart(store, 1));
    await waitFor(() => {
      expect(kept.result.current.lines).toEqual([{ clientLineId: 'a', itemId: DAL, quantity: 1 }]);
    });
    await store.setItem(CART_KEY, '{"not":"a cart"}');
    const unreadable = await renderHook(() => useCart(store, 2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(unreadable.result.current.lines).toEqual([]);
  });
});
