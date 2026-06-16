import type { Disposable, SlotPosition } from '../model/ethereum';

/**
 * Service interface for beacon chain slot timing operations
 *
 * Provides slot position calculations and timing-aware broadcasting
 * to prevent transactions from being affected by slot boundary fee changes.
 */
export interface ISlotTimingService extends Disposable {
  /**
   * Calculate the current slot position within the beacon chain
   *
   * @returns Current slot, position within slot, and time until next slot
   */
  calculateSlotPosition(): SlotPosition;

  /**
   * Wait for optimal broadcast window if near slot boundary
   *
   * If within the last portion of a slot, waits until the next slot starts
   * plus a small buffer. This prevents transactions from being broadcast
   * right before a fee change.
   */
  waitForOptimalBroadcastWindow(): Promise<void>;

  /**
   * Get the beacon chain slot length in seconds
   *
   * @returns Slot duration in seconds
   */
  getSecondsPerSlot(): number;

  /**
   * Get the appropriate block-change polling interval in milliseconds
   *
   * Derived from slot length: 2000ms for slots > 6s, 1000ms for slots ≤ 6s.
   *
   * @returns Polling interval in milliseconds
   */
  getPollIntervalMs(): number;
}
