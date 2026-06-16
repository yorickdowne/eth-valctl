import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { DEFAULT_SECONDS_PER_SLOT, SLOT_BOUNDARY_BUFFER_MS } from '../../constants/application';
import { BlockchainStateError } from '../../model/ethereum';

const MOCK_GENESIS_TIME = 1606824023;

interface MockFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<Record<string, unknown>>;
}

const createMockGenesisResponse = (): MockFetchResponse => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: () => Promise.resolve({ data: { genesis_time: String(MOCK_GENESIS_TIME) } })
});

const createMockSpecResponse = (secondsPerSlot?: string): MockFetchResponse => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: () => Promise.resolve({ data: { SECONDS_PER_SLOT: secondsPerSlot ?? '12' } })
});

const mockFetch = mock((_url: string): Promise<MockFetchResponse> => {
  if (_url.includes('/eth/v1/config/spec')) {
    return Promise.resolve(createMockSpecResponse());
  }
  return Promise.resolve(createMockGenesisResponse());
});

mock.module('undici', () => ({
  fetch: mockFetch
}));

const { BeaconService } = await import('./beacon-service');

describe('BeaconService', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockFetch.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('create', () => {
    it('fetches genesis time and config spec from beacon API', async () => {
      const service = await BeaconService.create('http://localhost:5052');

      expect(service).toBeInstanceOf(BeaconService);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:5052/eth/v1/beacon/genesis');
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:5052/eth/v1/config/spec');
    });

    it('throws BlockchainStateError when genesis fetch fails', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse());
        }
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: () => Promise.reject(new Error('no body'))
        });
      });

      await expect(BeaconService.create('http://localhost:5052')).rejects.toThrow(
        BlockchainStateError
      );
    });

    it('uses default seconds per slot when spec fetch fails', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service).toBeInstanceOf(BeaconService);
      expect(service.getSecondsPerSlot()).toBe(DEFAULT_SECONDS_PER_SLOT);
    });

    it('uses default seconds per slot when spec fetch returns invalid data', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: () => Promise.resolve({ data: { SECONDS_PER_SLOT: 'invalid' } })
          });
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service.getSecondsPerSlot()).toBe(DEFAULT_SECONDS_PER_SLOT);
    });

    it('parses configured seconds per slot from spec response', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse('4'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service.getSecondsPerSlot()).toBe(4);
    });

    it('includes original error as cause when network request fails', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse());
        }
        return Promise.reject(new Error('Network error'));
      });

      try {
        await BeaconService.create('http://localhost:5052');
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BlockchainStateError);
        expect((error as BlockchainStateError).cause).toBeInstanceOf(Error);
      }
    });
  });

  describe('calculateSlotPosition', () => {
    it('calculates correct slot position for known timestamp', async () => {
      mockFetch.mockResolvedValueOnce(createMockGenesisResponse());
      mockFetch.mockResolvedValueOnce(createMockSpecResponse());

      const service = await BeaconService.create('http://localhost:5052');

      const now = Math.floor(Date.now() / 1000);
      const expectedSlot = Math.floor((now - MOCK_GENESIS_TIME) / DEFAULT_SECONDS_PER_SLOT);

      const position = service.calculateSlotPosition();

      expect(position.currentSlot).toBe(expectedSlot);
      expect(position.secondInSlot).toBeGreaterThanOrEqual(0);
      expect(position.secondInSlot).toBeLessThan(DEFAULT_SECONDS_PER_SLOT);
      expect(position.secondsUntilNextSlot).toBeGreaterThan(0);
      expect(position.secondsUntilNextSlot).toBeLessThanOrEqual(DEFAULT_SECONDS_PER_SLOT);
      expect(position.secondInSlot + position.secondsUntilNextSlot).toBe(DEFAULT_SECONDS_PER_SLOT);
    });

    it('uses configured seconds per slot for calculations', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse('4'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      const now = Math.floor(Date.now() / 1000);
      const expectedSlot = Math.floor((now - MOCK_GENESIS_TIME) / 4);

      const position = service.calculateSlotPosition();

      expect(position.currentSlot).toBe(expectedSlot);
      expect(position.secondInSlot).toBeGreaterThanOrEqual(0);
      expect(position.secondInSlot).toBeLessThan(4);
      expect(position.secondsUntilNextSlot).toBeGreaterThan(0);
      expect(position.secondsUntilNextSlot).toBeLessThanOrEqual(4);
      expect(position.secondInSlot + position.secondsUntilNextSlot).toBe(4);
    });
  });

  describe('waitForOptimalBroadcastWindow', () => {
    it('does not wait when secondInSlot is below threshold', async () => {
      mockFetch.mockResolvedValueOnce(createMockGenesisResponse());
      mockFetch.mockResolvedValueOnce(createMockSpecResponse());

      const service = await BeaconService.create('http://localhost:5052');

      const boundaryThreshold = DEFAULT_SECONDS_PER_SLOT - 2;
      const calculateSlotPositionSpy = spyOn(service, 'calculateSlotPosition').mockReturnValue({
        currentSlot: 100,
        secondInSlot: boundaryThreshold - 1,
        secondsUntilNextSlot: DEFAULT_SECONDS_PER_SLOT - (boundaryThreshold - 1)
      });

      const startTime = Date.now();
      await service.waitForOptimalBroadcastWindow();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(100);
      expect(consoleSpy).not.toHaveBeenCalled();

      calculateSlotPositionSpy.mockRestore();
    });

    it('waits when secondInSlot equals threshold', async () => {
      mockFetch.mockResolvedValueOnce(createMockGenesisResponse());
      mockFetch.mockResolvedValueOnce(createMockSpecResponse());

      const service = await BeaconService.create('http://localhost:5052');

      const boundaryThreshold = DEFAULT_SECONDS_PER_SLOT - 2;
      const secondsUntilNext = 2;
      const calculateSlotPositionSpy = spyOn(service, 'calculateSlotPosition').mockReturnValue({
        currentSlot: 100,
        secondInSlot: boundaryThreshold,
        secondsUntilNextSlot: secondsUntilNext
      });

      const startTime = Date.now();
      await service.waitForOptimalBroadcastWindow();
      const elapsed = Date.now() - startTime;

      const expectedWaitMs = secondsUntilNext * 1000 + SLOT_BOUNDARY_BUFFER_MS;
      expect(elapsed).toBeGreaterThanOrEqual(expectedWaitMs - 50);
      expect(elapsed).toBeLessThan(expectedWaitMs + 100);
      expect(consoleSpy).toHaveBeenCalled();

      calculateSlotPositionSpy.mockRestore();
    });
  });

  describe('getSecondsPerSlot', () => {
    it('returns configured slot duration', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse('8'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service.getSecondsPerSlot()).toBe(8);
    });
  });

  describe('getPollIntervalMs', () => {
    it('returns 2000ms for slots longer than 6 seconds', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse('12'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service.getPollIntervalMs()).toBe(2000);
    });

    it('returns 1000ms for slots of 6 seconds or less', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse('6'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service.getPollIntervalMs()).toBe(1000);
    });

    it('returns 1000ms for 4-second slots', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.resolve(createMockSpecResponse('4'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service.getPollIntervalMs()).toBe(1000);
    });

    it('falls back to 2000ms when spec endpoint is unavailable', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/eth/v1/config/spec')) {
          return Promise.reject(new Error('timeout'));
        }
        return Promise.resolve(createMockGenesisResponse());
      });

      const service = await BeaconService.create('http://localhost:5052');

      expect(service.getSecondsPerSlot()).toBe(DEFAULT_SECONDS_PER_SLOT);
      expect(service.getPollIntervalMs()).toBe(2000);
    });
  });
});
