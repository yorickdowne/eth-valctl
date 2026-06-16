import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { JsonRpcProvider } from 'ethers';

import type { ISigner, SignerCapabilities } from '../../../ports/signer.interface';
import { BeaconService } from '../../infrastructure/beacon-service';
import { ParallelBroadcastStrategy } from './broadcast-strategy/parallel-broadcast-strategy';
import { SequentialBroadcastStrategy } from './broadcast-strategy/sequential-broadcast-strategy';
import { createTransactionPipeline } from './execution-layer-request-factory';

const SYSTEM_CONTRACT_ADDRESS = '0x0000BBdDc7CE488642fb579F8B00f3a590007251';
const BEACON_API_URL = 'http://localhost:5052';

/**
 * Minimal fake implementing the BeaconService-facing ISlotTimingService surface.
 * dispose() is spied to verify the factory wires it into the sequential strategy's cleanup chain.
 *
 * @returns A BeaconService test double whose methods are all jest/bun mock functions
 */
function createMockBeaconService(): BeaconService {
  return {
    calculateSlotPosition: mock(() => ({
      currentSlot: 1,
      secondInSlot: 0,
      secondsUntilNextSlot: 12
    })),
    waitForOptimalBroadcastWindow: mock(() => Promise.resolve()),
    dispose: mock(() => Promise.resolve()),
    getSecondsPerSlot: mock(() => 12),
    getPollIntervalMs: mock(() => 2000)
  } as unknown as BeaconService;
}

/**
 * Build a minimal ISigner stub with configurable parallel-signing capability.
 *
 * @param capabilities - Capability flags exposed on the signer
 * @returns ISigner double — only `capabilities` is read by the factory under test
 */
function createMockSigner(capabilities: SignerCapabilities): ISigner {
  return {
    capabilities,
    address: '0xMockSigner',
    sendTransaction: mock(() => Promise.reject(new Error('unexpected'))),
    sendTransactionWithNonce: mock(() => Promise.reject(new Error('unexpected'))),
    dispose: mock(() => Promise.resolve())
  } as unknown as ISigner;
}

/**
 * Produce a placeholder JsonRpcProvider reference for identity checks.
 *
 * @returns An opaque object stand-in for the real provider
 */
function createMockProvider(): JsonRpcProvider {
  return { __mockProvider: true } as unknown as JsonRpcProvider;
}

describe('createTransactionPipeline', () => {
  let beaconCreateSpy: ReturnType<typeof spyOn>;
  let parallelDisposeSpy: ReturnType<typeof spyOn>;
  let sequentialDisposeSpy: ReturnType<typeof spyOn>;
  let mockBeacon: BeaconService;

  beforeEach(() => {
    mockBeacon = createMockBeaconService();
    beaconCreateSpy = spyOn(BeaconService, 'create').mockImplementation(() =>
      Promise.resolve(mockBeacon)
    );
    parallelDisposeSpy = spyOn(ParallelBroadcastStrategy.prototype, 'dispose');
    sequentialDisposeSpy = spyOn(SequentialBroadcastStrategy.prototype, 'dispose');
  });

  afterEach(() => {
    beaconCreateSpy.mockRestore();
    parallelDisposeSpy.mockRestore();
    sequentialDisposeSpy.mockRestore();
  });

  describe('wallet signer (supportsParallelSigning === true)', () => {
    it('calls BeaconService.create', async () => {
      const signer = createMockSigner({ supportsParallelSigning: true });
      const provider = createMockProvider();

      await createTransactionPipeline(SYSTEM_CONTRACT_ADDRESS, provider, signer, BEACON_API_URL);

      expect(beaconCreateSpy).toHaveBeenCalledTimes(1);
    });

    it('returns a pipeline whose dispose invokes both BeaconService and ParallelBroadcastStrategy dispose', async () => {
      const signer = createMockSigner({ supportsParallelSigning: true });
      const provider = createMockProvider();

      const pipeline = await createTransactionPipeline(
        SYSTEM_CONTRACT_ADDRESS,
        provider,
        signer,
        BEACON_API_URL
      );
      await pipeline.dispose();

      expect(mockBeacon.dispose).toHaveBeenCalledTimes(1);
      expect(parallelDisposeSpy).toHaveBeenCalledTimes(1);
      expect(sequentialDisposeSpy).not.toHaveBeenCalled();
    });

    it('resolves without throwing when beacon API URL is empty', async () => {
      const signer = createMockSigner({ supportsParallelSigning: true });
      const provider = createMockProvider();

      await expect(
        createTransactionPipeline(SYSTEM_CONTRACT_ADDRESS, provider, signer, '')
      ).resolves.toBeDefined();

      // BeaconService.create is called immediately, so it will fail with empty URL
    });
  });

  describe('ledger signer (supportsParallelSigning === false)', () => {
    it('calls BeaconService.create exactly once with the beaconApiUrl', async () => {
      const signer = createMockSigner({ supportsParallelSigning: false });
      const provider = createMockProvider();

      await createTransactionPipeline(SYSTEM_CONTRACT_ADDRESS, provider, signer, BEACON_API_URL);

      expect(beaconCreateSpy).toHaveBeenCalledTimes(1);
      expect(beaconCreateSpy).toHaveBeenCalledWith(BEACON_API_URL);
    });

    it('returns a pipeline whose dispose invokes both BeaconService and SequentialBroadcastStrategy dispose', async () => {
      const signer = createMockSigner({ supportsParallelSigning: false });
      const provider = createMockProvider();

      const pipeline = await createTransactionPipeline(
        SYSTEM_CONTRACT_ADDRESS,
        provider,
        signer,
        BEACON_API_URL
      );
      await pipeline.dispose();

      // BeaconService.dispose is called twice: once by SequentialBroadcastStrategy
      // delegating to its slotTimingService, once by the pipeline's disposable list
      expect(mockBeacon.dispose).toHaveBeenCalledTimes(2);
      expect(sequentialDisposeSpy).toHaveBeenCalledTimes(1);
      expect(parallelDisposeSpy).not.toHaveBeenCalled();
    });
  });

  describe('error propagation', () => {
    it('propagates BeaconService.create rejection', async () => {
      const failure = new Error('beacon unreachable');
      beaconCreateSpy.mockImplementation(() => Promise.reject(failure));

      const signer = createMockSigner({ supportsParallelSigning: false });
      const provider = createMockProvider();

      await expect(
        createTransactionPipeline(SYSTEM_CONTRACT_ADDRESS, provider, signer, BEACON_API_URL)
      ).rejects.toThrow('beacon unreachable');
    });

    it('does not instantiate any broadcast strategy when BeaconService.create rejects', async () => {
      beaconCreateSpy.mockImplementation(() => Promise.reject(new Error('boom')));

      const signer = createMockSigner({ supportsParallelSigning: false });
      const provider = createMockProvider();

      await expect(
        createTransactionPipeline(SYSTEM_CONTRACT_ADDRESS, provider, signer, BEACON_API_URL)
      ).rejects.toThrow();

      expect(sequentialDisposeSpy).not.toHaveBeenCalled();
      expect(parallelDisposeSpy).not.toHaveBeenCalled();
      expect(mockBeacon.dispose).not.toHaveBeenCalled();
    });
  });
});
