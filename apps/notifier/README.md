# Discord notifier

Posts three kinds of event to three Discord channels:

| Channel | Contents |
| --- | --- |
| blocks | Settled mining blocks — winner, reward, prediction distance, and blocks nobody won |
| trades | Buys and sells above a dollar threshold |
| burns  | Trading-fee burns, buybacks, and rewards given up by exiting a vest early |

## Design

The notifier runs as a separate process from the indexer and reads its public
API. Ponder's app fingerprint covers its config, schema and handlers, so
changing any of them forces a fresh `DATABASE_SCHEMA` and a full re-index, which
replays every event since launch. Sending messages from an indexing handler
would therefore duplicate the entire history on each rebuild.

`/var/lib/bithook-notifier/cursor.json` records the last mining block, trade and
burn announced:

1. It is outside Postgres, so rebuilding the indexer's tables does not change
   what has been announced. Every poll re-reads the last 40 blocks and the full
   recent trade and burn lists and sends nothing, because the cursor decides.
2. With no cursor the service cold-starts: it records the current head and sends
   nothing. A lost cursor produces silence rather than a flood, which is why
   `scripts/deploy-notifier.sh` does not touch `/var/lib`.
3. Writes are atomic (temp file, then rename). A truncated cursor would read as
   a cold start and skip everything up to the head.

A ring buffer of the last 500 sent ids backs the cursor up, catching an
off-by-one at a boundary before it reaches a channel.

## Timing

- **Mining blocks** wait `3 × BLOCK_TIME + 120s` from the block's start. A
  prediction for block *n* is revealed during block *n+2*, and the contract
  treats *n* as settled only once `currentBlock() > n + 2`, so announcing
  earlier can name a winner that then changes.
- **Trades and burns** wait `NOTIFIER_CONFIRMATIONS` L1 blocks, because reorged
  rows are reverted by the indexer but a sent message cannot be unsent.

If the indexer is down or still syncing, the poll is skipped and the cursor is
not advanced, so the backlog is delivered on recovery.

## Configuration

`/etc/bithook/notifier.env`, mode 0600, root-owned. Webhook URLs are
credentials: they are never committed and never logged, and delivery errors are
reported by channel name because a failed fetch can carry the request URL.

| Variable | Default | Notes |
| --- | --- | --- |
| `NOTIFIER_MIN_TRADE_USD` | `1` | |
| `NOTIFIER_CONFIRMATIONS` | `5` | L1 blocks before a trade or burn is announced |
| `NOTIFIER_POLL_MS` | `20000` | |
| `NOTIFIER_STATE_DIR` | `/var/lib/bithook-notifier` | |

Changing a value requires `systemctl restart bithook-notifier`; the restart
re-reads the cursor from disk and does not resend anything.

## Operating

```
journalctl -u bithook-notifier -f       # follow
node dist/index.js --dry-run            # render to the log, send nothing
```

`--dry-run` still advances the cursor, so point it at a scratch
`NOTIFIER_STATE_DIR`. Do not run a second instance against the live state
directory: systemd prevents a double start of the unit, but a manual run
alongside it would double-send.
