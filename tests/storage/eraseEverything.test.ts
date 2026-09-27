import { describe, expect, it, vi } from 'vitest';
import { eraseEverything } from '../../src/storage/eraseEverything';

describe('eraseEverything', () => {
  it('clears local data only after the server erase succeeds', async () => {
    const calls: string[] = [];
    const bulkErase = vi.fn(async () => { calls.push('server'); });
    const clearLocal = vi.fn(async () => { calls.push('local'); });

    const result = await eraseEverything({ bulkErase, clearLocal });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['server', 'local']);
    expect(bulkErase).toHaveBeenCalledTimes(1);
    expect(clearLocal).toHaveBeenCalledTimes(1);
  });

  it('does not touch local data when the server erase fails', async () => {
    const bulkErase = vi.fn(async () => { throw new Error('network down'); });
    const clearLocal = vi.fn(async () => {});

    const result = await eraseEverything({ bulkErase, clearLocal });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('network down');
    expect(clearLocal).not.toHaveBeenCalled();
  });

  it('surfaces non-Error rejections in the failure message without throwing', async () => {
    const bulkErase = vi.fn(async () => { throw 'boom'; });
    const clearLocal = vi.fn(async () => {});

    const result = await eraseEverything({ bulkErase, clearLocal });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('boom');
    expect(clearLocal).not.toHaveBeenCalled();
  });
});
