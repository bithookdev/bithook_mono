import { Channel, sleep } from './discord.js';
import {
  BLOCK_TIME_S,
  blockEmbed,
  burnEmbed,
  tradeEmbed,
  type BlockRow,
  type BurnRow,
  type TradeRow,
} from './render.js';
import { Store, orderKey } from './state.js';

/**
 * Discord notifier for Bithook.
 *
 * Announces settled mining blocks, trades above a dollar threshold, and burns.
 *
 * Runs as a separate process from the indexer, reading its public API and
 * keeping its own cursor on disk, so that re-indexing does not re-announce
 * history. Three rules keep announcements exactly-once:
 *
 *  1. The cursor lives outside the indexer's database (see state.ts).
 *  2. A cold start records the current head and sends nothing, so a lost cursor
 *     produces silence rather than a replay.
 *  3. Nothing is announced until it is CONFIRMATIONS blocks behind the head,
 *     since reorged rows are reverted but a sent message cannot be unsent.
 */

const INDEXER = process.env.BITHOOK_INDEXER_URL ?? 'http://127.0.0.1:42069';
const WEB = process.env.BITHOOK_WEB_URL ?? 'http://127.0.0.1:3000';
const STATE_DIR = process.env.NOTIFIER_STATE_DIR ?? '/var/lib/bithook-notifier';
const POLL_MS = Number(process.env.NOTIFIER_POLL_MS ?? 20_000);
const CONFIRMATIONS = BigInt(process.env.NOTIFIER_CONFIRMATIONS ?? 5);
const MIN_TRADE_USD = Number(process.env.NOTIFIER_MIN_TRADE_USD ?? 1);
/**
 * How long after a block starts its result is final.
 *
 * A prediction for block n is revealed during block n+2, and the contract only
 * treats n as settled once `currentBlock() > n + 2` (Bithook.sol, the
 * `BlockNotSettled` guard). So the winner can still change for three full block
 * times after n begins — announce earlier and the message can be wrong. The
 * margin covers the drift between a block's nominal boundary and the indexed
 * timestamp of the first event seen in it.
 */
const SETTLE_AFTER_S = 3 * BLOCK_TIME_S;
const SETTLE_MARGIN_S = 120;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.NOTIFIER_DRY_RUN === '1';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const channels = {
  blocks: new Channel('blocks', process.env.DISCORD_WEBHOOK_BLOCKS, DRY_RUN, log),
  trades: new Channel('trades', process.env.DISCORD_WEBHOOK_TRADES, DRY_RUN, log),
  burns: new Channel('burns', process.env.DISCORD_WEBHOOK_BURNS, DRY_RUN, log),
};

async function getJson<T>(base: string, path: string): Promise<T | null> {
  try {
    // No `cache` option: this is Node's fetch, not the browser's, and the
    // indexer sets its own cache headers anyway.
    const res = await fetch(`${base}${path}`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Prices, refreshed lazily. Null when unavailable — figures are then omitted. */
let priceCache: { at: number; ethUsd: number | null; usdPerTok: number | null } = {
  at: 0,
  ethUsd: null,
  usdPerTok: null,
};

async function prices() {
  if (Date.now() - priceCache.at < 60_000) return priceCache;
  const s = await getJson<{ ethUsd: number | null; usdPerBithook: number | null }>(WEB, '/api/state');
  priceCache = {
    at: Date.now(),
    ethUsd: s?.ethUsd ?? null,
    usdPerTok: s?.usdPerBithook ?? null,
  };
  return priceCache;
}

interface Status {
  mainnet?: { block?: { number?: number; timestamp?: number }; ready?: boolean };
}

async function tick(store: Store): Promise<void> {
  const status = await getJson<Status>(INDEXER, '/status');
  const head = status?.mainnet?.block?.number;
  const chainTime = status?.mainnet?.block?.timestamp;
  if (head === undefined || chainTime === undefined || status?.mainnet?.ready !== true) {
    // Indexer down or still catching up. Crucially the cursor is NOT advanced,
    // so nothing is skipped — this poll simply did not happen.
    log('indexer not ready; skipping this poll');
    return;
  }
  const safeHead = BigInt(head) - CONFIRMATIONS;

  const [blocksRes, tradesRes, burnsRes] = await Promise.all([
    getJson<{ blocks: BlockRow[] }>(INDEXER, '/mining/blocks?limit=40'),
    getJson<{ trades: TradeRow[] }>(INDEXER, '/trades'),
    getJson<{ recent: BurnRow[] }>(INDEXER, '/burns'),
  ]);

  const cur = store.get();

  // --- cold start: record where we are, announce nothing -------------------
  if (store.isCold()) {
    const newestSettled = (blocksRes?.blocks ?? [])
      .filter((b) => chainTime > b.startTs + SETTLE_AFTER_S + SETTLE_MARGIN_S)
      .map((b) => BigInt(b.n))
      .reduce((a, b) => (b > a ? b : a), -1n);
    const newestTrade = (tradesRes?.trades ?? [])
      .map((t) => orderKey(t.block, t.logIndex))
      .sort()
      .at(-1);
    const newestBurn = (burnsRes?.recent ?? [])
      .map((b) => orderKey(b.blockNumber, b.id.split(':')[1] ?? '0'))
      .sort()
      .at(-1);

    store.seed({
      lastBlockN: newestSettled >= 0n ? newestSettled.toString() : '0',
      lastTradeKey: newestTrade ?? orderKey(head, 0),
      lastBurnKey: newestBurn ?? orderKey(head, 0),
    });
    log(
      `cold start: seeded at block #${newestSettled} / head ${head} — nothing sent. ` +
        'Only events after this point will be announced.',
    );
    return;
  }

  const p = await prices();
  const sentIds: string[] = [];

  // --- settled mining blocks ----------------------------------------------
  const lastN = BigInt(cur.lastBlockN ?? '0');
  const dueBlocks = (blocksRes?.blocks ?? [])
    .filter((b) => BigInt(b.n) > lastN)
    .filter((b) => chainTime > b.startTs + SETTLE_AFTER_S + SETTLE_MARGIN_S)
    .sort((a, b) => Number(BigInt(a.n) - BigInt(b.n)));

  for (const b of dueBlocks) {
    const id = `block:${b.n}`;
    if (store.seen(id)) continue;
    await channels.blocks.send([blockEmbed(b, p.ethUsd)]);
    sentIds.push(id);
  }
  if (dueBlocks.length > 0) {
    store.markSent(sentIds);
    store.advance({ lastBlockN: dueBlocks.at(-1)!.n });
  }

  // --- trades -------------------------------------------------------------
  const lastTrade = cur.lastTradeKey ?? '';
  const dueTrades = (tradesRes?.trades ?? [])
    .filter((t) => BigInt(t.block) <= safeHead)
    .filter((t) => orderKey(t.block, t.logIndex) > lastTrade)
    .sort((a, b) => (orderKey(a.block, a.logIndex) < orderKey(b.block, b.logIndex) ? -1 : 1));

  const tradeIds: string[] = [];
  const worthSending = dueTrades.filter((t) => {
    // Below the threshold still advances the cursor — it was seen and judged,
    // just not worth a message. Otherwise it would be re-evaluated forever.
    if (p.ethUsd === null) return true; // no price: rather over-report than drop
    return (Number(t.eth) / 1e18) * p.ethUsd >= MIN_TRADE_USD;
  });

  if (worthSending.length > 0) {
    // Batched: Discord allows ten embeds per message and rate limits per
    // webhook, so a busy block posts once rather than ten times.
    for (let i = 0; i < worthSending.length; i += 10) {
      const batch = worthSending.slice(i, i + 10);
      await channels.trades.send(batch.map((t) => tradeEmbed(t, p.ethUsd)));
      tradeIds.push(...batch.map((t) => `trade:${t.hash}:${t.logIndex}`));
    }
  }
  if (dueTrades.length > 0) {
    store.markSent(tradeIds);
    const last = dueTrades.at(-1)!;
    store.advance({ lastTradeKey: orderKey(last.block, last.logIndex) });
  }

  // --- burns ---------------------------------------------------------------
  const lastBurn = cur.lastBurnKey ?? '';
  const burnKey = (b: BurnRow) => orderKey(b.blockNumber, b.id.split(':')[1] ?? '0');
  const dueBurns = (burnsRes?.recent ?? [])
    .filter((b) => BigInt(b.blockNumber) <= safeHead)
    .filter((b) => burnKey(b) > lastBurn)
    .sort((a, b) => (burnKey(a) < burnKey(b) ? -1 : 1));

  const burnIds: string[] = [];
  for (let i = 0; i < dueBurns.length; i += 10) {
    const batch = dueBurns.slice(i, i + 10);
    await channels.burns.send(batch.map((b) => burnEmbed(b, p.usdPerTok)));
    burnIds.push(...batch.map((b) => `burn:${b.id}`));
  }
  if (dueBurns.length > 0) {
    store.markSent(burnIds);
    store.advance({ lastBurnKey: burnKey(dueBurns.at(-1)!) });
  }

  if (sentIds.length || worthSending.length || dueBurns.length) {
    // Counts what actually went out, not what was due: the ring buffer can
    // suppress an already-announced block, and that gap is worth seeing.
    log(
      `sent — blocks:${sentIds.length}/${dueBlocks.length} ` +
        `trades:${worthSending.length}/${dueTrades.length} burns:${dueBurns.length}`,
    );
  }
}

async function main() {
  const store = new Store(STATE_DIR);
  log(
    `notifier starting — indexer=${INDEXER} confirmations=${CONFIRMATIONS} ` +
      `minTradeUsd=$${MIN_TRADE_USD} dryRun=${DRY_RUN}`,
  );
  for (const c of Object.values(channels)) {
    if (!c.configured) log(`channel "${c.name}" has no webhook configured — skipping it`);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick(store);
    } catch (err) {
      log(`poll failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`);
    }
    await sleep(POLL_MS);
  }
}

void main();
