import type { FloorResponse, TableOverviewResponse } from '@rp/contracts';
import { useConsole } from '../app/console-context.js';
import { type LiveData, useLive } from '../app/use-live.js';
import { affectsFloor } from './floor-view.js';

export type FloorData = LiveData<{
  readonly floor: FloorResponse;
  readonly overview: TableOverviewResponse;
}>;

/**
 * The floor and the live table overview (TBL-007), read again after table, order and bill events
 * and when the connection comes back.
 */
export function useFloor(): { data: FloorData; reload: () => void } {
  const controller = useConsole();
  return useLive(async () => {
    const [floor, overview] = await Promise.all([
      controller.api.getFloor(),
      controller.api.getTableOverview(),
    ]);
    return { floor, overview };
  }, affectsFloor);
}
