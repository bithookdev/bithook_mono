/**
 * Shared formatting helpers.
 *
 * No 'server-only' here on purpose: the same dollar figure has to render in the
 * server-rendered stat cards and in the client-side mining form, and having two
 * copies of the rounding rule is how those two drift apart.
 */

/**
 * Format a dollar amount.
 *
 * Two behaviours that matter:
 *
 *  - Sub-cent amounts fall back to significant digits. BITHOOK trades around
 *    two cents, so a plain 2-decimal format would render the token price as
 *    "$0.02" and a small deposit as "$0.00".
 *
 *  - Above a cent the fraction is padded, so 1.2 renders as "$1.20" rather than
 *    "$1.2". `maximumFractionDigits` alone drops trailing zeros, which reads as
 *    a typo on a currency. The minimum is capped at 2 so that a whole-dollar
 *    format (digits = 0) still renders "$120", not "$120.00".
 */
export function usd(n: number, digits = 2): string {
  if (n < 0.01) return `$${plain(n, 3)}`;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: Math.min(digits, 2),
    maximumFractionDigits: digits,
  })}`;
}

/**
 * A number in plain decimal, never scientific notation.
 *
 * `toPrecision` switches to exponential below 1e-6, and BITHOOK crossed that
 * line as the price fell — so prices started rendering as "9.551e-7". That is
 * unreadable in a stat card and actively bad in the prediction input, where the
 * nudge buttons were writing "9.55100e-7" as the value to commit.
 *
 * Keeps `sig` significant digits and trims trailing zeros, so 9.551e-7 becomes
 * 0.0000009551 and 20.06 stays 20.06.
 */
export function plain(n: number, sig = 4): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.min(18, Math.max(0, sig - 1 - exp));
  return n
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}
