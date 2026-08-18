import Link from 'next/link';

import { getLeaderboard } from '../../lib/mining-api';

export const revalidate = 30;
export const metadata = { title: 'Miners — Bithook' };

const tok = (wei: string) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 });
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

export default async function MinersPage() {
  const data = await getLeaderboard(100);

  return (
    <main className="wrap">
      <header className="masthead">
        <Link className="backlink" href="/">← Bithook</Link>
        <h1>Who is mining</h1>
        <p className="sub">
          Wins are counted from the actual outcome of each block, not from claims —
          an unclaimed win still counts. Reveal rate is worth reading: anything
          below 100% is deposits that were forfeited to a missed window.
        </p>
      </header>

      {!data || data.miners.length === 0 ? (
        <div className="feed empty">No miners yet.</div>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Address</th><th>Wins</th><th>Mined</th>
                <th>Predictions</th><th>Revealed</th><th>Reveal rate</th><th>Mean miss</th>
              </tr>
            </thead>
            <tbody>
              {data.miners.map((m) => (
                <tr key={m.address}>
                  <td><Link className="addr link" href={`/miners/${m.address}`}>{short(m.address)}</Link></td>
                  <td className="num">{m.wins}</td>
                  <td className="num">{tok(m.totalWon)}</td>
                  <td className="num">{m.commits}</td>
                  <td className="num">{m.reveals}</td>
                  <td className="num">
                    {m.revealRate === null ? '—' : `${Math.round(m.revealRate * 100)}%`}
                  </td>
                  <td className="num">{m.meanDist?.toLocaleString() ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
