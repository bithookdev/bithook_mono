import Link from 'next/link';

import { getBlock } from '../../../lib/mining-api';

export const revalidate = 10;

const tok = (wei: string) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 });
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

export default async function BlockPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  const data = await getBlock(n);

  if (!data) {
    return (
      <main className="wrap">
        <header className="masthead">
          <Link className="backlink" href="/blocks">← All blocks</Link>
          <h1>Block #{n}</h1>
        </header>
        <div className="feed empty">
          No record of this block. Either it has not happened yet, or the indexer
          cannot be reached.
        </div>
      </main>
    );
  }

  const { block: b, reveals } = data;
  const sorted = [...reveals].sort((x, y) => Number(BigInt(x.dist) - BigInt(y.dist)));
  const ticks = reveals.map((r) => r.tick);
  /**
   * Scale to where people actually predicted, keeping the target in frame.
   *
   * Two failure modes to avoid. Spanning plain min-to-max let one wild guess set
   * the axis and squeeze everyone else into an unreadable clump — a block with
   * 24 miners inside 100 ticks and one 28,000 off drew 24 overlapping dots and a
   * lone marker. Forcing the target to the centre instead wastes half the width
   * whenever predictions all land on one side, which happens often.
   *
   * So the bounds come from the 5th and 95th percentile of the predictions,
   * widened to include the target and padded. Outliers past that are pinned to
   * the edge and counted rather than allowed to flatten the picture.
   */
  const target = b.targetTick ?? 0;
  const ascending = [...ticks].sort((x, y) => x - y);
  const q = (f: number) =>
    ascending[Math.min(ascending.length - 1, Math.max(0, Math.round((ascending.length - 1) * f)))] ?? target;
  let lo = Math.min(q(0.05), target);
  let hi = Math.max(q(0.95), target);
  const pad = Math.max(8, (hi - lo) * 0.12);
  lo -= pad;
  hi += pad;
  const span = Math.max(1, hi - lo);
  /**
   * Mapped into a 4-96% band rather than 0-100: a dot sits on its centre, so an
   * extreme one would otherwise have half of itself clipped by the panel edge.
   */
  const pos = (tick: number) =>
    4 + ((Math.min(hi, Math.max(lo, tick)) - lo) / span) * 92;
  const beyond = ticks.filter((x) => x < lo || x > hi).length;

  /** Deterministic vertical offset so overlapping dots stay countable. */
  const lane = (i: number) => ((i * 37) % 5) - 2;

  return (
    <main className="wrap">
      <header className="masthead">
        <Link className="backlink" href="/blocks">← All blocks</Link>
        <h1>Block #{b.n}</h1>
        <p className="sub">
          {b.commits} sealed prediction{b.commits === 1 ? '' : 's'}, {b.reveals} opened.
          {b.commits > b.reveals && (
            <> {b.commits - b.reveals} deposit{b.commits - b.reveals === 1 ? '' : 's'} forfeited
            by not revealing.</>
          )}
        </p>
      </header>

      <section>
        <div className="grid">
          <div className="stat">
            <div className="k">Target tick</div>
            <div className="v accent">{b.targetTick?.toLocaleString() ?? '—'}</div>
            <div className="n">{b.targetResolvable ? 'the average this block was scored against' : 'never resolved'}</div>
          </div>
          <div className="stat">
            <div className="k">Reward</div>
            <div className="v">{tok(b.reward)}</div>
            <div className="n">
              {!b.winner
                ? 'destroyed — nobody predicted'
                : data.vest
                  ? `claimed · released over ${Math.round((data.vest.duration ?? 0) / 86400)} days`
                  : b.claimed
                    ? 'claimed, vesting'
                    : 'won, not claimed yet'}
            </div>
          </div>

          {/* This page showed nothing about early exit while the inline panel did,
              so the same block gave two different answers depending on where it
              was read. */}
          {data.vest?.exited && (
            <div className="stat">
            <div className="k">Taken early</div>
            <div className="v down">&minus;{tok(data.vest.slashed)}</div>
            <div className="n">BITHOOK destroyed by exiting the vest before it finished</div>
            </div>
          )}
          <div className="stat">
            <div className="k">Deposit</div>
            <div className="v">{tok(b.deposit)}</div>
            <div className="n">per prediction</div>
          </div>
        </div>
      </section>

      {sorted.length > 0 && (
        <section>
          <div className="eyebrow">Predictions</div>
          <h2>How close everyone got</h2>
          <div className="scatter">
            <div className="saxis" aria-hidden="true" />
            {b.targetTick !== null && (
              <div className="starget" style={{ left: `${pos(target)}%` }}>
                <span className="slabel">target {target.toLocaleString()}</span>
              </div>
            )}
            {sorted.map((r, i) => {
              const clamped = r.tick < lo || r.tick > hi;
              return (
                <div
                  key={r.who + r.hash}
                  className={`sdot${i === 0 ? ' swin' : ''}${clamped ? ' sfar' : ''}`}
                  style={{ left: `${pos(r.tick)}%`, marginTop: `${lane(i) * 7}px` }}
                  title={`${r.who} — tick ${r.tick.toLocaleString()}, ${Number(r.dist).toLocaleString()} off${clamped ? ' (beyond the axis)' : ''}`}
                />
              );
            })}
            <span className="sedge left">{Math.round(lo).toLocaleString()}</span>
            <span className="sedge right">{Math.round(hi).toLocaleString()}</span>
          </div>
          <p className="pfine sfoot">
            Each dot is one revealed prediction, placed by how far it sat from the
            answer in ticks. The winner is highlighted.
            {beyond > 0 && (
              <>
                {' '}
                {beyond} prediction{beyond > 1 ? 's were' : ' was'} further out than
                the axis shows and {beyond > 1 ? 'sit' : 'sits'} pinned to the edge,
                so one wild guess cannot flatten everyone else.
              </>
            )}
          </p>

          <div className="tw">
            <table>
              <thead>
                <tr><th>#</th><th>Address</th><th>Predicted tick</th><th>Off by</th></tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={r.who + r.hash}>
                    <td className="num">{i + 1}</td>
                    <td><Link className="addr link" href={`/miners/${r.who}`}>{short(r.who)}</Link></td>
                    <td className="num">{r.tick.toLocaleString()}</td>
                    <td className="num">{Number(r.dist).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
