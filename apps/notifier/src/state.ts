import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Durable record of what has already been announced.
 *
 * The cursor is kept outside the indexer's database so that rebuilding the
 * indexer does not re-announce history.
 *
 * Writes are atomic (temp file, then rename): a truncated cursor would read as
 * a cold start and skip everything up to the current head.
 */

export interface Cursor {
  version: 1;
  /** When this cursor was first created, for operator sanity. */
  seededAt: string;
  /** Highest settled mining block announced. */
  lastBlockN: string | null;
  /** Highest trade announced, as `${l1Block}:${logIndex}` zero-padded. */
  lastTradeKey: string | null;
  /** Highest burn announced, same shape. */
  lastBurnKey: string | null;
  /**
   * Ring buffer of recently sent ids. Redundant against the cursors above,
   * which is the point: it catches an off-by-one at a boundary before it
   * becomes a duplicate in someone's channel.
   */
  recent: string[];
}

const RECENT_MAX = 500;

/** Sortable key so string comparison orders correctly across block boundaries. */
export function orderKey(block: string | number, logIndex: string | number): string {
  return `${String(block).padStart(12, '0')}:${String(logIndex).padStart(6, '0')}`;
}

export function emptyCursor(): Cursor {
  return {
    version: 1,
    seededAt: new Date().toISOString(),
    lastBlockN: null,
    lastTradeKey: null,
    lastBurnKey: null,
    recent: [],
  };
}

export class Store {
  private cursor: Cursor;
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'cursor.json');
    mkdirSync(dirname(this.path), { recursive: true });
    this.cursor = this.load();
  }

  private load(): Cursor {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Cursor;
      if (parsed?.version !== 1) throw new Error('unknown cursor version');
      parsed.recent ??= [];
      return parsed;
    } catch {
      // Missing or unreadable. The caller seeds from the current head and sends
      // nothing, so a lost cursor produces silence rather than a replay of
      // everything that ever happened.
      return emptyCursor();
    }
  }

  get(): Cursor {
    return this.cursor;
  }

  /** True before the first successful seed — the caller must not send. */
  isCold(): boolean {
    const c = this.cursor;
    return c.lastBlockN === null && c.lastTradeKey === null && c.lastBurnKey === null;
  }

  seen(id: string): boolean {
    return this.cursor.recent.includes(id);
  }

  markSent(ids: string[]): void {
    if (ids.length === 0) return;
    this.cursor.recent = [...this.cursor.recent, ...ids].slice(-RECENT_MAX);
  }

  advance(patch: Partial<Pick<Cursor, 'lastBlockN' | 'lastTradeKey' | 'lastBurnKey'>>): void {
    Object.assign(this.cursor, patch);
    this.persist();
  }

  private persist(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.cursor, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Write without sending: used on cold start and by --seed. */
  seed(patch: Partial<Pick<Cursor, 'lastBlockN' | 'lastTradeKey' | 'lastBurnKey'>>): void {
    this.cursor = { ...emptyCursor(), ...this.cursor, ...patch };
    this.persist();
  }
}
