'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Blocking first-run risk disclosure.
 *
 * Deliberately not a cookie banner: nothing is pre-checked, there is no
 * "remind me later", the risk list is not collapsed, and the accept button
 * stays disabled until the reader has both ticked the AI-authorship
 * acknowledgement and actually reached the bottom of the risk list.
 *
 * The storage key is versioned so that materially changing the copy re-shows
 * the gate to everyone who already accepted the old text. v2 added the
 * AI-authorship disclosure, v3 the vesting schedule, v5 rewrote the mining-cost
 * entry and added the dollar-conversion note, v6 corrected the gas figures.
 *
 * Three rules this list is held to, all learned the hard way:
 *
 *  - **Mechanics only — the site draws no conclusion about mining returns.**
 *    Entries say what the contract does: what gas is spent, how the reward
 *    shrinks, what the deposit locks. What that adds up to is the reader's to
 *    judge, and every attempt to express it here became either advice or a
 *    number that rots.
 *
 *  - **No figure derived from the token price.** One entry once carried a fixed
 *    gas threshold computed against the pool's OPENING price. The token
 *    appreciated ~170x and the figure was wrong by a hundredfold within days —
 *    while still reading perfectly plausibly, which is why nobody caught it.
 *    Price-dependent numbers belong in the live UI, computed, or nowhere.
 *
 *  - **No number carried forward unmeasured.** This entry claimed ~121,000 gas
 *    for a commit+reveal pair from the project's earliest notes onward, and it
 *    was repeated into the README, both plan documents and the public agent
 *    instructions without anyone running it. It is the cost of the *leading
 *    reveal leg alone* — one half of the operation, reported as the whole. The
 *    real pair is ~143k-207k depending on whether the reveal takes the lead.
 *    test/SkillDocFlow.t.sol now measures all of it against mainnet bytecode.
 */
const ACK_KEY = 'bithook.risk.ack.v6';

export const RISKS: readonly string[] = [
  'Every line of this — the contract and this site — was written by AI and has never been reviewed by a human engineer.',
  'Total loss is a realistic outcome. Assume the contract can be drained and that you will not get your money back.',
  'No professional firm has audited this. There has been one external audit and 252 local tests. That is not the same thing.',
  'If you mine and fail to reveal inside the 10-minute window, your entire deposit is burned. It cannot be recovered by anyone.',
  'Winning does not pay out immediately. A won block releases gradually over the length of its era — seven days for the first week — and taking it early destroys half of whatever has not released yet.',
  'Mining is capital-weighted, like hashpower — not skill-weighted. Once capital is committed, each additional prediction costs nothing extra, so someone submitting many predictions across a range wins far more blocks than someone submitting a single accurate one. A miner submitting one prediction against a 50-wide spread takes about 2% of blocks.',
  'Mining spends gas on every commit and every reveal, and that gas is spent whether or not you win. Measured against the deployed contract: about 86,000 gas to commit, and about 57,000 to reveal without taking the lead or 121,000 to take it — so roughly 143,000 to 207,000 for the pair. The block reward is a fixed number of BITHOOK that quarters at every era boundary.',
  'Dollar amounts on this site are reference conversions, not prices you can trade at. They come from multiplying the pool tick by a Chainlink ETH/USD reading, and both halves of that move continuously.',
  'Exact ties are decided by an address hash, which can be ground out in advance when the target is predictable.',
  'Liquidity is permanently sealed. Fees are burned rather than compounded, so pool depth never grows from trading — only from net buying. Nobody can add depth, ever.',
  'There is no external arbitrage anchor. The price is whatever this one sealed pool says it is, so early outcomes are closer to random than to anything that can be forecast.',
  'Mainnet has a public mempool. Your commits are visible before they land.',
  'This is not investment advice, and nobody is running any of this on your behalf.',
];

export function RiskGate() {
  const [ready, setReady] = useState(false);
  const [accepted, setAccepted] = useState(true); // assume accepted until known
  const [readToEnd, setReadToEnd] = useState(false);
  const [aiAck, setAiAck] = useState(false); // never pre-checked
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setAccepted(window.localStorage.getItem(ACK_KEY) === '1');
    setReady(true);
  }, []);

  useEffect(() => {
    if (accepted || !ready) return;
    const el = endRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setReadToEnd(true);
      },
      { threshold: 1 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [accepted, ready]);

  // Don't flash the gate before localStorage has been read.
  if (!ready || accepted) return null;

  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="risk-title">
      <div className="gatebox">
        <h2 id="risk-title">Read this before you go any further</h2>
        <p className="sub">
          Bithook is experimental software holding real money on Ethereum mainnet.
          It is far more likely to lose your money than to make you any.
        </p>

        <div className="aiblock">
          <span className="lbl">How this was built</span>
          <p>
            <b>
              The contract, this website and everything around them were written by
              AI. No human engineer has reviewed the code.
            </b>{' '}
            Nobody has checked the maths, the economics or the security of what you
            are about to interact with. AI writes confident, plausible-looking code
            that can be subtly and catastrophically wrong, and no one has audited
            this for exactly the kind of mistake that drains a contract.
          </p>
          <label className="aicheck">
            <input
              type="checkbox"
              checked={aiAck}
              onChange={(e) => setAiAck(e.target.checked)}
            />
            <span>
              I understand this software was written by AI and has never been
              reviewed by a human.
            </span>
          </label>
        </div>

        <ul>
          {RISKS.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>

        <div ref={endRef} />
        <p className="scrollnote">
          {!readToEnd
            ? 'Scroll to the end of the list to continue.'
            : !aiAck
              ? 'Tick the AI acknowledgement above to continue.'
              : 'You have read the full list.'}
        </p>

        <button
          type="button"
          className="accept"
          disabled={!readToEnd || !aiAck}
          onClick={() => {
            window.localStorage.setItem(ACK_KEY, '1');
            setAccepted(true);
          }}
        >
          I understand I can lose everything
        </button>
      </div>
    </div>
  );
}
