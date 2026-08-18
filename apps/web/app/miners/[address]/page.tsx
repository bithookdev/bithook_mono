import Link from 'next/link';

import { getMiner } from '../../../lib/mining-api';

export const revalidate = 15;

const tok = (wei: string) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 });
const when = (ts: number) => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16);

export default async function MinerPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const data = await getMiner(address);
  const m = data?.miner;
  // Early-exit losses are recorded per vest; the miner-level figure is their sum.
  const slashedTotal = (data?.vests ?? []).reduce(
    (acc, v) => acc + BigInt(v.slashed ?? '0'),
    0n,
  );

  return (
    <main className="wrap">
      <header className="masthead">
        <Link className="backlink" href="/miners">← All miners</Link>
        <h1>Miner</h1>
        <p className="addr">{address}</p>
      </header>

      {!data || !m ? (
        <div className="feed empty">This address has not mined anything.</div>
      ) : (
        <>
          <section>
            <div className="grid">
              <div className="stat"><div className="k">Blocks won</div><div className="v accent">{m.wins}</div><div className="n">counted from outcomes, not claims</div></div>
              <div className="stat"><div className="k">Mined</div><div className="v">{tok(m.totalWon)}</div><div className="n">BITHOOK</div></div>
              <div className="stat"><div className="k">Reveal rate</div><div className="v">{m.commits > 0 ? `${Math.round((m.reveals / m.commits) * 100)}%` : '—'}</div><div className="n">{m.commits - m.reveals} deposit(s) forfeited</div></div>
              <div className="stat"><div className="k">Mean miss</div><div className="v">{m.meanDist?.toLocaleString() ?? '—'}</div><div className="n">ticks from target</div></div>
              {/* Only rendered once there is something to show. Exiting a vest early
                  destroys half of whatever had not released; a permanent zero card
                  would imply the reader had done something wrong. */}
              {slashedTotal > 0n && (
                <div className="stat"><div className="k">Destroyed by early exit</div><div className="v down">−{tok(slashedTotal.toString())}</div><div className="n">BITHOOK given up by not waiting for the vest</div></div>
              )}
            </div>
          </section>

          {data.unclaimed.length > 0 && (
            <section>
              <div className="eyebrow">Unclaimed</div>
              <h2>Won but not claimed</h2>
              <p className="lede">Nothing expires — these stay claimable indefinitely.</p>
              <div className="tw">
                <table>
                  <thead><tr><th>Block</th><th>Reward</th></tr></thead>
                  <tbody>
                    {data.unclaimed.map((b) => (
                      <tr key={b.n}>
                        <td className="num"><Link href={`/blocks/${b.n}`}>#{b.n}</Link></td>
                        <td className="num">{tok(b.reward)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {data.locks.filter((l) => !l.unlocked && Number(l.amount) > 0).length > 0 && (
            <section>
              <div className="eyebrow">Deposits</div>
              <h2>Locked</h2>
              <p className="lede">
                Deposits are returned in full on reveal, then held for part of the era
                before they can be withdrawn.
              </p>
              <div className="tw">
                <table>
                  <thead><tr><th>Slice</th><th>Amount</th><th>Unlocks</th></tr></thead>
                  <tbody>
                    {data.locks.filter((l) => !l.unlocked && Number(l.amount) > 0).map((l) => (
                      <tr key={l.slice}>
                        <td className="num">{l.slice}</td>
                        <td className="num">{tok(l.amount)}</td>
                        <td className="num">{when(l.unlockAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {data.vests.length > 0 && (
            <section>
              <div className="eyebrow">Vesting</div>
              <h2>Rewards being released</h2>
              <div className="tw">
                <table>
                  <thead><tr><th>Block</th><th>Total</th><th>Released</th><th>Over</th></tr></thead>
                  <tbody>
                    {data.vests.map((v) => (
                      <tr key={v.vestId}>
                        <td className="num">{v.blockN ? <Link href={`/blocks/${v.blockN}`}>#{v.blockN}</Link> : '—'}</td>
                        <td className="num">{tok(v.total)}</td>
                        <td className="num">{tok(v.released)}</td>
                        <td className="num">{v.duration ? `${Math.round(v.duration / 86400)}d` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
