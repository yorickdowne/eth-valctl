import chalk from 'chalk';
import { fetch } from 'undici';

import * as application from '../../constants/application';
import { SLOT_BOUNDARY_WAIT_INFO } from '../../constants/logging';
import type { ConfigSpecResponse, GenesisResponse, SlotPosition } from '../../model/ethereum';
import { BlockchainStateError } from '../../model/ethereum';
import type { ISlotTimingService } from '../../ports/slot-timing.interface';

/**
 * Service for beacon chain timing operations.
 *
 * Fetches genesis time and slot duration from the Beacon API to enable
 * slot-aware transaction broadcasting for hardware wallets.
 */
export class BeaconService implements ISlotTimingService {
  private readonly secondsPerSlot: number;
  private readonly slotBoundaryThreshold: number;

  private constructor(
    private readonly genesisTime: number,
    secondsPerSlot: number
  ) {
    this.secondsPerSlot = secondsPerSlot;
    const buffer =
      secondsPerSlot <= application.SHORT_SLOT_THRESHOLD
        ? 1
        : application.SLOT_BOUNDARY_BUFFER_SECONDS;
    this.slotBoundaryThreshold = secondsPerSlot - buffer;
  }

  /**
   * Create a beacon service by fetching genesis time and slot config from the Beacon API
   *
   * Fetches genesis time (required) and config spec (non-fatal fallback) to determine
   * slot duration and timing parameters.
   *
   * @param beaconApiUrl - Base URL of the beacon API
   * @returns Initialized beacon service instance
   * @throws BlockchainStateError if genesis fetch fails or returns invalid data
   */
  static async create(beaconApiUrl: string): Promise<BeaconService> {
    let genesisTime: number;
    try {
      const genesisUrl = `${beaconApiUrl}${application.GENESIS_BEACON_API_ENDPOINT}`;
      const genesisResponse = await fetch(genesisUrl);

      if (!genesisResponse.ok) {
        throw new BlockchainStateError(
          `Failed to fetch beacon genesis: ${genesisResponse.status} ${genesisResponse.statusText}`
        );
      }

      const genesisData = (await genesisResponse.json()) as GenesisResponse;
      const genesisTimeStr = genesisData.data.genesis_time;
      const parsed = parseInt(genesisTimeStr, 10);

      if (isNaN(parsed)) {
        throw new BlockchainStateError(
          `Invalid genesis time received from beacon API: ${genesisTimeStr}`
        );
      }

      genesisTime = parsed;
    } catch (error) {
      if (error instanceof BlockchainStateError) {
        throw error;
      }
      throw new BlockchainStateError('Unable to initialize beacon service', error);
    }

    let secondsPerSlot = application.DEFAULT_SECONDS_PER_SLOT;
    try {
      const specUrl = `${beaconApiUrl}${application.CONFIG_SPEC_BEACON_API_ENDPOINT}`;
      const specResponse = await fetch(specUrl);
      if (specResponse.ok) {
        const specData = (await specResponse.json()) as ConfigSpecResponse;
        if (specData.data.SECONDS_PER_SLOT) {
          const parsed = parseInt(specData.data.SECONDS_PER_SLOT, 10);
          if (!isNaN(parsed) && parsed > 0) {
            secondsPerSlot = parsed;
          }
        }
      }
    } catch {
      // Non-fatal — use default
    }

    return new BeaconService(genesisTime, secondsPerSlot);
  }

  /**
   * No-op disposal — beacon service holds no persistent resources
   */
  async dispose(): Promise<void> {}

  /**
   * Calculate the current slot position within the beacon chain
   *
   * @returns Current slot, position within slot, and time until next slot
   */
  calculateSlotPosition(): SlotPosition {
    const now = Math.floor(Date.now() / application.MS_PER_SECOND);
    const secondsSinceGenesis = now - this.genesisTime;
    const currentSlot = Math.floor(secondsSinceGenesis / this.secondsPerSlot);
    const secondInSlot = secondsSinceGenesis % this.secondsPerSlot;
    return {
      currentSlot,
      secondInSlot,
      secondsUntilNextSlot: this.secondsPerSlot - secondInSlot
    };
  }

  /**
   * Wait for optimal broadcast window if near slot boundary
   *
   * If within the last portion of a slot (at or past slotBoundaryThreshold seconds),
   * waits until the next slot starts plus a small buffer. This prevents
   * transactions from being broadcast right before a fee change.
   */
  async waitForOptimalBroadcastWindow(): Promise<void> {
    const position = this.calculateSlotPosition();
    if (position.secondInSlot >= this.slotBoundaryThreshold) {
      const waitMs = position.secondsUntilNextSlot * 1000 + application.SLOT_BOUNDARY_BUFFER_MS;
      console.log(chalk.yellow(SLOT_BOUNDARY_WAIT_INFO(position.secondsUntilNextSlot)));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Get the beacon chain slot length in seconds
   *
   * @returns Slot duration in seconds
   */
  getSecondsPerSlot(): number {
    return this.secondsPerSlot;
  }

  /**
   * Get the appropriate block-change polling interval in milliseconds
   *
   * Returns 2000ms for slots > 6s, 1000ms for slots ≤ 6s.
   *
   * @returns Polling interval in milliseconds
   */
  getPollIntervalMs(): number {
    return this.secondsPerSlot <= application.SHORT_SLOT_THRESHOLD ? 1000 : 2000;
  }
}
