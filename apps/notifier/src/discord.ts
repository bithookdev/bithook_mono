/**
 * Discord webhook delivery.
 *
 * Webhook URLs are credentials, so they never appear in a log line, not even
 * inside an error: every failure path reports the channel by name.
 *
 * Discord rate limits per webhook (roughly five requests per two seconds), so
 * sends are serialised per channel with a minimum gap, and a 429 response is
 * obeyed rather than retried blindly.
 */

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

const MIN_GAP_MS = 450;
const MAX_ATTEMPTS = 4;

export class Channel {
  private queue: Promise<void> = Promise.resolve();
  private lastSentAt = 0;
  /** Set when the webhook is gone for good, so we stop hammering a dead URL. */
  private disabled = false;

  constructor(
    readonly name: string,
    private readonly url: string | undefined,
    private readonly dryRun: boolean,
    private readonly log: (msg: string) => void,
  ) {}

  get configured(): boolean {
    return Boolean(this.url) && !this.disabled;
  }

  /** Resolves once the message is delivered, or dropped after retries. */
  send(embeds: Embed[]): Promise<void> {
    if (!this.configured || embeds.length === 0) return Promise.resolve();
    this.queue = this.queue.then(() => this.deliver(embeds));
    return this.queue;
  }

  private async deliver(embeds: Embed[]): Promise<void> {
    if (this.dryRun) {
      this.log(`[dry-run] ${this.name}: would send ${embeds.length} embed(s): ${embeds
        .map((e) => e.title ?? '(untitled)')
        .join(' | ')}`);
      return;
    }

    const wait = MIN_GAP_MS - (Date.now() - this.lastSentAt);
    if (wait > 0) await sleep(wait);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(this.url!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ embeds: embeds.slice(0, 10) }),
          signal: AbortSignal.timeout(15_000),
        });
        this.lastSentAt = Date.now();

        if (res.ok || res.status === 204) return;

        if (res.status === 429) {
          const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
          const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
          this.log(`${this.name}: rate limited, waiting ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }

        if (res.status === 404 || res.status === 401 || res.status === 403) {
          // The webhook was deleted or revoked. Retrying forever would just
          // burn requests every poll; say so once and stop.
          this.disabled = true;
          this.log(`${this.name}: webhook rejected (${res.status}) — disabling this channel`);
          return;
        }

        this.log(`${this.name}: HTTP ${res.status}, attempt ${attempt}/${MAX_ATTEMPTS}`);
      } catch (err) {
        // Deliberately not interpolating the error: a fetch failure can carry
        // the request URL, and the URL is the credential.
        const kind = err instanceof Error ? err.name : 'unknown';
        this.log(`${this.name}: request failed (${kind}), attempt ${attempt}/${MAX_ATTEMPTS}`);
      }
      await sleep(500 * attempt);
    }
    this.log(`${this.name}: giving up on a message after ${MAX_ATTEMPTS} attempts`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
