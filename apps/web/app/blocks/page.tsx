import Link from 'next/link';

import { getBlocks } from '../../lib/mining-api';

export const revalidate = 15;
export const metadata = { title: 'Blocks — Bithook' };

const tok = (wei: string) => {
  const n = Number(wei) / 1e18;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export default async function BlocksPage() {
  const data = await getBlocks(60);

  return (
    <main className="wrap">
      <header className="masthead">
        <Link className="backlink" href="/">← Bithook</Link>
        <h1>Every mining block</h1>
        <p className="sub">
          One block every ten minutes. A block with no predictions has its reward
          destroyed rather than carried forward, so gaps here are tokens that will
          never exist.
        </p>
      </header>

      {!data ? (
        <div className="feed empty">
          The indexer is not reachable right now. Mining data will appear once it is.
        </div>
      ) : data.blocks.length === 0 ? (
        <div className="feed empty">
          No mining blocks yet — mining has not been switched on.
        </div>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Block</th><th>Age</th><th>Predictions</th><th>Target</th>
                <th>Winner</th><th>Off by</th><th>Reward</th><th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.blocks.map((b) => (
                <tr key={b.n}>
                  <td className="num"><Link href={`/blocks/${b.n}`}>#{b.n}</Link></td>
                  <td className="num">{ago(b.startTs)}</td>
                  <td className="num">{b.reveals}/{b.commits}</td>
                  <td className="num">{b.targetTick?.toLocaleString() ?? '—'}</td>
                  <td className="num">
                    {b.winner ? <Link href={`/miners/${b.winner}`}>{short(b.winner)}</Link> : '—'}
                  </td>
                  <td className="num">{b.bestDist ? Number(b.bestDist).toLocaleString() : '—'}</td>
                  <td className="num">{tok(b.reward)}</td>
                  <td className="num">
                    {!b.targetResolvable ? 'unresolved'
                      : b.winner === null ? 'no winner'
                      : b.claimed ? 'claimed' : 'unclaimed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
