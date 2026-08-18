import type { Embed } from './discord.js';

/**
 * ETH per BITHOOK from a Uniswap tick.
 *
 * Inlined rather than imported from @bithook/core, which ships TypeScript
 * source meant for bundlers while this service runs as plain compiled Node.
 * This is the tick identity 1.0001^-tick; packages/core carries the
 * differential test that pins it against the contract.
 */
const tickToEthPerBithook = (tick: number): number => Math.exp(-tick * Math.log1p(1e-4));

/** Bithook.sol: `BLOCK_TIME = 10 minutes`. */
export const BLOCK_TIME_S = 600;

/** Message bodies. Kept apart from delivery so they can be eyeballed in dry-run. */

const SITE = 'https://bithook.tools';
const ETHERSCAN = 'https://etherscan.io';

const PINK = 0xec4899;
const GREEN = 0x12784a;
const ORANGE = 0xb3401c;
const GREY = 0x8b877f;

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const num = (n: number, d = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });

export function tok(wei: string, d = 2): string {
  const v = Number(wei) / 1e18;
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return `${num(v / 1e6, 2)}M`;
  if (v >= 1e3) return `${num(v / 1e3, 1)}k`;
  return num(v, d);
}

/** Plain decimal — BITHOOK is below 1e-6, where toPrecision goes exponential. */
export function plain(n: number, sig = 4): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.min(18, Math.max(0, sig - 1 - exp));
  return n.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export const usd = (n: number) =>
  n < 0.01 ? `$${plain(n, 3)}` : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------

export interface BlockRow {
  n: string;
  reward: string;
  commits: number;
  reveals: number;
  targetTick: number | null;
  winner: string | null;
  bestDist: string | null;
  startTs: number;
}

export function blockEmbed(b: BlockRow, ethUsd: number | null): Embed {
  const burned = Math.max(0, b.commits - b.reveals);
  const price = b.targetTick !== null ? tickToEthPerBithook(b.targetTick) : null;

  if (!b.winner) {
    return {
      title: `Block #${b.n} — nobody won it`,
      url: `${SITE}/blocks/${b.n}`,
      color: GREY,
      description:
        `No prediction was revealed, so the block's **${tok(b.reward)} BITHOOK** was ` +
        'minted and burned in the same transaction. It was never issued and the ' +
        'schedule does not carry it forward.',
      fields: [
        { name: 'Took part', value: `${b.reveals}/${b.commits} revealed`, inline: true },
        ...(burned > 0
          ? [{ name: 'Deposits lost', value: `${burned}`, inline: true }]
          : []),
      ],
      timestamp: new Date((b.startTs + BLOCK_TIME_S) * 1000).toISOString(),
    };
  }

  const off = b.bestDist === null ? null : Number(b.bestDist);
  const offPct = off === null ? null : Math.expm1(off * Math.log1p(1e-4)) * 100;

  return {
    title: `Block #${b.n} mined`,
    url: `${SITE}/blocks/${b.n}`,
    color: PINK,
    fields: [
      { name: 'Winner', value: `[${short(b.winner)}](${ETHERSCAN}/address/${b.winner})`, inline: true },
      { name: 'Reward', value: `${tok(b.reward)} BITHOOK`, inline: true },
      {
        name: 'Off by',
        value:
          off === null
            ? '—'
            : `${off.toLocaleString()} tick${off === 1 ? '' : 's'} · ${offPct!.toFixed(2)}%`,
        inline: true,
      },
      {
        name: 'The answer',
        value:
          b.targetTick === null
            ? '—'
            : `tick ${b.targetTick.toLocaleString()} · ${plain(price!)} ETH` +
              (ethUsd !== null ? ` · ${usd(price! * ethUsd)}` : ''),
        inline: true,
      },
      {
        name: 'Took part',
        value: `${b.reveals}/${b.commits} revealed` + (burned > 0 ? ` · ${burned} deposit${burned > 1 ? 's' : ''} lost` : ''),
        inline: true,
      },
    ],
    footer: { text: 'Claiming starts a vesting schedule — it does not pay out at once' },
    timestamp: new Date((b.startTs + BLOCK_TIME_S) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------

export interface TradeRow {
  hash: string;
  block: string;
  logIndex: string;
  kind: string;
  eth: string;
  bithook: string;
  tick: string;
  ts: string;
}

export function tradeEmbed(t: TradeRow, ethUsd: number | null): Embed {
  const buy = t.kind === 'buy';
  const ethAmt = Number(t.eth) / 1e18;
  const price = tickToEthPerBithook(Number(t.tick));

  return {
    title: `${buy ? 'Buy' : 'Sell'} · ${num(ethAmt, 5)} ETH`,
    url: `${ETHERSCAN}/tx/${t.hash}`,
    color: buy ? GREEN : ORANGE,
    fields: [
      { name: 'BITHOOK', value: tok(t.bithook, 0), inline: true },
      {
        name: 'Value',
        value: ethUsd !== null ? usd(ethAmt * ethUsd) : `${num(ethAmt, 5)} ETH`,
        inline: true,
      },
      {
        name: 'Price',
        value: `${plain(price)} ETH` + (ethUsd !== null ? ` · ${usd(price * ethUsd)}` : ''),
        inline: true,
      },
    ],
    // Bithook.sol: FEE_BPS = 100. Stated as the mechanic rather than a computed
    // per-trade figure — the fee is charged on the swap's unspecified amount,
    // which is not one of the fields this row carries.
    footer: { text: 'A 1% fee is charged on every trade and burned' },
    timestamp: new Date(Number(t.ts) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------

export interface BurnRow {
  id: string;
  kind: string;
  amount: string;
  ethSpent: string | null;
  destroysSupply: boolean;
  ts: number;
  blockNumber: string;
  hash: string;
}

const BURN_TITLE: Record<string, string> = {
  fee: 'Trading fees burned',
  buyback: 'Bought back and burned',
  unrevealedStake: 'Forfeited deposits burned',
  exitSlash: 'Reward given up by exiting early',
};

/**
 * @param usdPerTok dollars per BITHOOK, not per ETH — a burn is denominated in
 * tokens, so pricing it with the ETH rate would be wrong by five orders of
 * magnitude.
 */
export function burnEmbed(b: BurnRow, usdPerTok: number | null): Embed {
  const amt = Number(b.amount) / 1e18;
  const eth = b.ethSpent ? Number(b.ethSpent) / 1e18 : null;

  return {
    title: BURN_TITLE[b.kind] ?? `Burned (${b.kind})`,
    url: `${ETHERSCAN}/tx/${b.hash}`,
    color: ORANGE,
    description:
      b.kind === 'exitSlash'
        ? 'Someone took a mining reward before its vest finished. Half of what had ' +
          'not released yet was destroyed.'
        : undefined,
    fields: [
      { name: 'Amount', value: `${tok(b.amount)} BITHOOK`, inline: true },
      ...(eth !== null ? [{ name: 'ETH spent', value: `${num(eth, 5)}`, inline: true }] : []),
      ...(usdPerTok !== null
        ? [{ name: 'Worth', value: usd(amt * usdPerTok), inline: true }]
        : []),
      {
        name: 'Effect on supply',
        value: b.destroysSupply
          ? 'Total supply fell by this amount'
          : 'Minted and burned in one transaction — net-zero on supply, but it lowers the 21M ceiling permanently',
        inline: false,
      },
    ],
    timestamp: new Date(b.ts * 1000).toISOString(),
  };
}
