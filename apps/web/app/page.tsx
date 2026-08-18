import {
  ADDRESSES,
  BLOCK_TIME,
  ERA_ONE,
  MAX_SUPPLY,
  scheduleCap,
  scheduledBlockReward,
  stakeFor,
} from '@bithook/core';

import { BlockStrip } from '../components/BlockStrip';
import { SupplyBar } from '../components/SupplyBar';
import {
  LiveFooter,
  MiningTotals,
  PoolCards,
  SupplyCards,
  type StateJson,
} from '../components/LiveFigures';
import { BurnActions } from '../components/BurnActions';
import { MiningClock } from '../components/MiningClock';
import { MiningPanel } from '../components/MiningPanel';
import { LiveTrades } from '../components/LiveTrades';
import { getProtocolState } from '../lib/chain';
import { usd as usdFmt } from '../lib/format';

// Short cache: fresh enough for a price, and it collapses bursts of traffic
// into one RPC read (which matters behind a CDN).
export const revalidate = 15;

const fmt = (n: number, d = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Token amounts are 18-decimal; render them at human scale. */
function tok(wei: bigint, digits = 2): string {
  const n = Number(wei) / 1e18;
  if (n === 0) return '0';
  if (n >= 1e6) return `${fmt(n / 1e6, 2)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3, 1)}k`;
  if (n < 0.01) return '<0.01';
  return fmt(n, digits);
}

const eth = (wei: bigint, d = 4) => fmt(Number(wei) / 1e18, d);

const usd = (n: number | null, d = 2) => (n === null ? null : usdFmt(n, d));

/** Era table rows, derived from the same schedule functions the chain uses. */
function eraRows(count = 7) {
  const rows = [];
  let start = 0n;
  let duration = ERA_ONE;
  for (let k = 0; k < count; k++) {
    const end = start + duration;
    const firstBlock = start / BLOCK_TIME;
    rows.push({
      era: k + 1,
      days: Number(duration / 86_400n),
      startsDay: Number(start / 86_400n),
      total: scheduleCap(end) - scheduleCap(start),
      perBlock: scheduledBlockReward(firstBlock),
      stake: stakeFor(firstBlock),
      cumulative: (Number(scheduleCap(end)) / Number(scheduleCap(ERA_ONE * 1_000_000n))) * 100,
    });
    start = end;
    duration *= 2n;
  }
  return rows;
}

export default async function Page() {
  const s = await getProtocolState();
  // Seed for the client-polled figures. Same numbers the server just rendered,
  // handed over as JSON so they can keep moving without refreshing the route.
  const seed: StateJson = {
    tick: s.tick,
    ethPerBithook: s.ethPerBithook,
    bithookPerEth: s.bithookPerEth,
    fdvEth: s.fdvEth,
    ethUsd: s.ethUsd,
    usdPerBithook: s.usdPerBithook,
    fdvUsd: s.fdvUsd,
    totalSupply: s.totalSupply.toString(),
    destroyed: s.destroyed.toString(),
    feeBurned: s.feeBurned.toString(),
    buybackBurned: s.buybackBurned.toString(),
    stakesBurned: s.stakesBurned.toString(),
    slashed: s.slashed.toString(),
    lockedStakes: s.lockedStakes.toString(),
    minedSoFar: s.minedSoFar.toString(),
    releasedByNow: s.releasedByNow.toString(),
    pendingEth: s.pendingEth.toString(),
    pendingToken: s.pendingToken.toString(),
    blockNumber: s.blockNumber.toString(),
    chainTime: s.chainTime.toString(),
    fetchedAt: s.fetchedAt,
  };
  const rows = eraRows();
  const currentEra = s.miningArmed
    ? Number(BigInt(Math.floor(Date.now() / 1000)) - s.miningStart) / 86_400
    : null;

  return (
    <main className="wrap">
      <header className="masthead">
        <div className="brandline">
          <svg className="mark" viewBox="0 0 256 256" role="img" aria-label="Bithook">
            <g transform="translate(-13.401 -29.791) scale(1.16861)" fill="currentColor" fillRule="evenodd">
              <path d="M97 78C97 64 100 48 108 34C116 48 119 64 119 78ZM116.8 57.1 117.7 61.8 97.1 74.2 97.1 73.8 97.4 68.7ZM114.2 47.9 115.4 51.9 98.3 62.2 98.4 61.5 99.3 56.9ZM111.2 40.3 112.4 43.1 101.2 49.8 101.4 49.1 102.7 45.5Z" />
              <rect x="76" y="200" width="24" height="36" rx="3" />
              <rect x="116" y="200" width="24" height="36" rx="3" />
              <path d="M54 78H112C148 78 176 88 176 106C176 124 164 136 150 143C170 149 188 160 188 178C188 197 156 208 112 208H54V184H68V104H54ZM98 104H124C137 104 144 108 144 115C144 122 137 126 124 126H98ZM98 162H130C146 162 154 166 154 173C154 180 146 184 130 184H98Z" />
            </g>
          </svg>
          <span className="wordmark">Bithook</span>
        </div>
        <h1>Bitcoin, but as a Uniswap hook</h1>
        <p className="sub">
          Every ten minutes, whoever predicts the token&rsquo;s own average price most
          closely receives that block&rsquo;s reward. That is how half of the 21 million
          supply is handed out. The other half is permanently locked liquidity.
        </p>
      </header>

      <section>
        <div className="eyebrow">Mining</div>
        {s.miningArmed ? (
          <>
            <h2>Mining is live</h2>
            <p className="lede">
              Day {fmt(currentEra ?? 0, 2)} since emission started. Three blocks are
              always in flight, and they all roll over on the same ten-minute
              boundary.
            </p>
            <MiningClock
              miningStart={s.miningStart.toString()}
              chainTime={s.chainTime.toString()}
              fetchedAt={s.fetchedAt}
            />
            <BlockStrip
              miningStart={s.miningStart.toString()}
              chainTime={s.chainTime.toString()}
              fetchedAt={s.fetchedAt}
              ethUsd={s.ethUsd}
            />
            <MiningPanel
              miningStart={s.miningStart.toString()}
              chainTime={s.chainTime.toString()}
              fetchedAt={s.fetchedAt}
              currentTick={s.tick}
              ethUsd={s.ethUsd}
            />
            <MiningTotals initial={seed} />
          </>
        ) : (
          <>
            <h2>Nobody can mine yet</h2>
            <p className="lede">
              Right now BITHOOK only trades. Mining is switched on separately, so the
              first predictions are made against a price that trading has already set,
              rather than the opening price written into the contract.
            </p>
            <p className="lede">
              The emission schedule starts when mining is switched on, not when the
              contract was deployed.
            </p>
            <MiningClock
              miningStart={s.miningStart.toString()}
              chainTime={s.chainTime.toString()}
              fetchedAt={s.fetchedAt}
            />
          </>
        )}
      </section>

      <section>
        <div className="eyebrow">Trades</div>
        <h2>What is happening right now</h2>
        <p className="lede">
          Every buy and sell on the pool as it lands. 1% of each one is taken and
          destroyed.
        </p>
        <LiveTrades />
      </section>

      <section>
        <div className="eyebrow">Pool</div>
        <PoolCards initial={seed} />
      </section>

      <section>
        <div className="eyebrow">Supply</div>
        <h2>What has actually been destroyed</h2>
        <p className="lede">
          &ldquo;Burned&rdquo; gets used for two completely different things here, and
          only one of them really shrinks the supply. Fees the pool collected, and
          deposits miners forfeited, were real tokens that now no longer exist.
        </p>
        <p className="lede">
          The other kind is just bookkeeping. When a block receives no predictions, its reward is
          created and destroyed in the same transaction. Explorers show that as a
          burn, but nothing was ever really added, so nothing was really taken away —
          it is a reward that was never handed out. Add the two together and the burn
          looks about twice as big as it is, which is why they are split here.
        </p>
        <SupplyCards initial={seed} />
        <SupplyBar initial={seed} />
      </section>

      <section>
        <div className="eyebrow">Anyone can do this</div>
        <h2>Burn the fees yourself</h2>
        <p className="lede">
          The 1% fee sits in the contract until someone triggers the burn — contracts
          cannot act on their own. These three functions do that. Any address can call
          them, no reward is paid for doing so, and the caller pays the gas.
        </p>
        <BurnActions miningArmed={s.miningArmed} initial={seed} />
      </section>

      <section>
        <div className="eyebrow">Docs</div>
        <h2>How it actually works</h2>
        <p className="lede">
          Two contracts, with no admin functions and no upgrade mechanism. What is
          described below is what the deployed bytecode does, and it cannot be changed
          by anyone, including the deployer.
        </p>

        <div className="docs">
          <div className="doc glass">
            <h3>The two contracts</h3>
            <p>
              <strong>The token</strong> is an ordinary ERC-20 capped at 21 million.
              At launch it created 10.5M and then permanently handed the power to
              create any more over to the second contract. That handover was a
              one-time switch and it cannot be flipped back — not by the creator, not
              by anyone. The only tokens that can ever appear now are mining rewards,
              on the fixed schedule.
            </p>
            <p>
              <strong>The hook</strong> plugs directly into
              Uniswap so it runs on every single trade. It holds all the liquidity,
              runs the mining mechanism, takes the 1% fee and destroys it.
            </p>
          </div>

          <div className="doc glass">
            <h3>The launch curve</h3>
            <p>
              Every one of the 10.5M tokens went into the pool with{' '}
              <strong>no ETH alongside them</strong>. The opening price therefore
              follows from where that liquidity was placed. There was no pre-sale and
              no allocation was withheld.
            </p>
            <p>
              After that the liquidity is <strong>sealed</strong>. Every attempt to add
              or remove any of it reverts, for every address, with no exception for the
              deployer.
            </p>
          </div>

          <div className="doc glass">
            <h3>Mining: three blocks in flight</h3>
            <p>
              Blocks are ten minutes long and run purely on the clock — block n starts
              at <code>miningStart + 600n</code> seconds, and that is the whole rule.
              No transaction is needed to open the next block, and no account has the
              ability to start or stop one.
            </p>
            <ol>
              <li>
                <strong>You predict.</strong> You send in a scrambled version of your
                prediction — <code>keccak(tick, salt, sender)</code> — plus a deposit worth
                1% of the block reward. Nobody, including you, can change it later, and
                nobody else can read it.
              </li>
              <li>
                <strong>The answer forms.</strong> Over the next ten minutes the pool
                records its own average price. That average is the target. Predictions
                closed before this window even started, so there was nothing to copy.
              </li>
              <li>
                <strong>You reveal it.</strong> In the third window you unscramble
                it. Your deposit comes back and, if you are closest so far, you take
                the lead.
              </li>
            </ol>
            <p>
              By the time anyone reveals, the target is already public, so each
              prediction scores itself on the spot. There is no counting round at the
              end and no limit on how many addresses can take part. Exact ties are settled by
              hashing the address, not by who showed first — otherwise whoever could
              pay to jump the queue would take every tie.
            </p>
          </div>

          <div className="doc glass">
            <h3>What the deposit really costs</h3>
            <p>
              The deposit is not a fee. If you reveal, you get every token of it
              back — nothing is taken, nothing is taxed. What it actually
              costs you is <strong>time</strong>: the deposit is frozen for a while
              afterwards, so submitting many predictions means having a lot of tokens
              tied up at once.
            </p>
            <p>
              A prediction that is never revealed forfeits the whole deposit. The contract
              has no recovery path for it.
            </p>
          </div>

          <div className="doc glass">
            <h3>Winning does not pay out at once</h3>
            <p>
              A won block does not arrive as a lump sum. Claiming it starts a
              release schedule as long as the era the block belonged to, capped at
              112 days — so a block won in the first week releases over{' '}
              <strong>seven days</strong>. The tokens are created as they release;
              they do not exist before that.
            </p>
            <p>
              You can take it early, and the cost is specific: <strong>half of
              whatever has not released yet is destroyed</strong>. The part that has
              already released is unaffected. Waiting costs nothing — the full
              amount arrives on its own, and there is no deadline to claim.
            </p>
            <p>
              This is separate from the deposit, which is not a payment at all and
              comes back in full the moment you reveal.
            </p>
          </div>

          <div className="doc glass">
            <h3>Fees: 100% destroyed</h3>
            <p>
              Every trade pays 1%, and the contract burns all of it. No portion is
              routed to a treasury, a deployer address or any other recipient — the
              contract contains no function that would allow it.
            </p>
            <p>
              Fees collected in BITHOOK are burned directly. Fees collected in ETH are
              spent buying BITHOOK on this pool, and whatever is bought is burned. That
              second path executes a swap, so it moves the pool price exactly as any
              other trade of the same size would.
            </p>
          </div>

          <div className="doc glass">
            <h3>Emission, and why it never ends</h3>
            <p>
              Rewards run on the clock and nothing else. No amount of trading volume,
              hype or activity speeds them up or slows them down. Every block is worth
              exactly what the schedule says it is worth, whether a thousand people
              are taking part or none.
            </p>
            <p>
              If a block receives no predictions, its reward is <strong>destroyed rather than
              carried forward</strong>. It does not roll into the next block and does
              not increase any later reward. As a result, the timing of a claim and the
              ordering of transactions cannot change what anyone receives.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="eyebrow">Emission</div>
        <h2>How the emission schedule works</h2>
        <p className="lede">
          Each era runs twice as long as the one before it — 7 days, then 14, then 28
          — and each hands out half of whatever mining supply is left. The total
          creeps toward 10.5M forever without ever quite arriving.
        </p>
        <p className="lede">
          Because each era lasts twice as long but pays out half as much, the reward
          per block drops to a <strong>quarter</strong> at every transition. Era one
          emits 5.25M BITHOOK, a quarter of the 21M total.
        </p>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Era</th>
                <th>Days</th>
                <th>Starts day</th>
                <th>Era total</th>
                <th>Per block</th>
                <th>Deposit (1%)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.era}>
                  <td className="num">{r.era}</td>
                  <td className="num">{fmt(r.days)}</td>
                  <td className="num">{fmt(r.startsDay)}</td>
                  <td className="num">{tok(r.total)}</td>
                  <td className="num">{fmt(Number(r.perBlock) / 1e18, 2)}</td>
                  <td className="num">{fmt(Number(r.stake) / 1e18, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="eyebrow">Launch curve</div>
        <h2>How the liquidity is set up</h2>
        <p className="lede">
          All 10.5M tokens were placed into the pool as liquidity, with no ETH
          alongside them. The opening price was determined by where that liquidity
          sits, not by anyone buying in first.
        </p>
        <p className="lede">
          That liquidity is then sealed. Every attempt to add or remove any of it
          reverts, for every address, permanently. It covers a fixed price range, and
          the pool can only trade inside that range.
        </p>
        <div className="note danger">
          <span className="lbl">Swap behaviour</span>
          <p>
            A swap that would move the price outside the seeded range reverts in full
            rather than partially filling. The transaction fails and its gas is spent.
          </p>
        </div>
      </section>

      <section>
        <div className="eyebrow">Contracts</div>
        <h2>Verify everything yourself</h2>
        <p className="lede">
          Liquidity is permanently sealed: every external add or remove reverts, at
          all times, by design. Minting authority was handed to the hook irreversibly
          at launch.
        </p>
        <div className="tw">
          <table>
            <tbody>
              {[
                {
                  label: 'Token',
                  addr: ADDRESSES.token,
                  extra: {
                    href: 'https://dexscreener.com/ethereum/0x8a3d7e939d3eaa59811e90fb671519500fe30b227c95da6fca8f4c56859fc874',
                    title: 'Chart on DexScreener',
                    icon: 'chart' as const,
                  },
                },
                {
                  label: 'Hook',
                  addr: ADDRESSES.hook,
                  extra: {
                    href: 'https://app.uniswap.org/explore/tokens/ethereum/0x386c4cb30d2861adb02ecbdfea76f6a67ed2cddc',
                    title: 'Trade on Uniswap',
                    icon: 'swap' as const,
                  },
                },
                { label: 'Uniswap v4 PoolManager', addr: ADDRESSES.poolManager, extra: null },
              ].map((c) => (
                <tr key={c.addr}>
                  <td>{c.label}</td>
                  <td>
                    <span className="addrcell">
                      {/* The address itself stays the explorer link — that is what
                          someone verifying the deployment expects to click. */}
                      <a
                        className="addr link"
                        href={`https://etherscan.io/address/${c.addr}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {c.addr}
                      </a>
                      {c.extra && (
                        <a
                          className="addricon"
                          href={c.extra.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={c.extra.title}
                          aria-label={c.extra.title}
                        >
                          {/* Drawn rather than fetched: the CSP allows no external
                              images, and a generic glyph avoids passing off an
                              approximation as someone's trademark. */}
                          {c.extra.icon === 'chart' ? (
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <rect x="2" y="8" width="2.6" height="6" rx="0.8" />
                              <rect x="6.7" y="4" width="2.6" height="10" rx="0.8" />
                              <rect x="11.4" y="6" width="2.6" height="8" rx="0.8" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path
                                d="M3 6h8M8.5 3.2 11.8 6 8.5 8.8M13 10H5M7.5 7.2 4.2 10l3.3 2.8"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </a>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="pfine">
          Running an agent?{' '}
          <a href="/SKILL.md">/SKILL.md</a> documents the mining calls, the exact
          commitment encoding and the ways a deposit gets burned. Its instructions
          are executed against the deployed contract by a test, so they cannot
          quietly drift from it.
        </p>
      </section>

      <footer>
        {/* The only route to the index pages since the masthead pills came out.
            Without these, /blocks and /miners were reachable only by typing a
            URL — including the per-block pages linked from shared links. */}
        <nav className="footnav">
          <a href="/blocks">All blocks</a>
          <a href="/miners">All miners</a>
          <a href="/SKILL.md">For agents</a>
          <a
            href="https://x.com/bithook_v4"
            target="_blank"
            rel="noopener noreferrer"
          >
            @bithook_v4
          </a>
        </nav>
        <LiveFooter initial={seed} />
      </footer>
    </main>
  );
}
