import { describe, expect, it } from 'vitest';

import { POOL_ID } from '../src/constants.js';
import { decodeSlot0, poolStateSlot } from '../src/pool.js';

describe('poolStateSlot', () => {
  it('matches the slot verified against mainnet', () => {
    // Cross-checked with `cast keccak` and confirmed to return live pool data
    // from PoolManager.extsload on mainnet.
    expect(poolStateSlot(POOL_ID)).toBe(
      '0x5dcebb2172f1c594b5cb5011a27ea6daf2677eba6e11f69061d956cc2c5bb738',
    );
  });
});

describe('decodeSlot0', () => {
  it('decodes a real mainnet slot0 word', () => {
    const raw = '0x00000000000000000001e43d00000000000001ebbceae74be3f2bea4dd2d6aa3';
    const s = decodeSlot0(raw);
    expect(s.tick).toBe(123_965);
    expect(s.sqrtPriceX96).toBe(38_959_494_957_258_581_203_399_748_709_027n);
    expect(s.protocolFee).toBe(0);
    expect(s.lpFee).toBe(0); // the pool's LP fee is zero; the 1% is the hook's
  });

  it('decodes negative ticks as two-s complement', () => {
    // The tail band reaches -887,200. Without sign handling this decodes as
    // ~16.7 million and every price below the graduation tick is wrong.
    const tick = -887_200;
    const packed = (BigInt(tick >>> 0 ? (1 << 24) + tick : tick) & 0xffffffn) << 160n;
    expect(decodeSlot0(`0x${packed.toString(16).padStart(64, '0')}`).tick).toBe(tick);
  });

  it('round-trips the full int24 range boundaries', () => {
    for (const tick of [0, 1, -1, 8_388_607, -8_388_608, 164_600, -887_200]) {
      const packed = (BigInt(tick < 0 ? tick + (1 << 24) : tick) & 0xffffffn) << 160n;
      expect(decodeSlot0(`0x${packed.toString(16).padStart(64, '0')}`).tick).toBe(tick);
    }
  });
});
