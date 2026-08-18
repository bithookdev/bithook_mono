#!/usr/bin/env bash
#
# Pre-flight for any owner-only call (startMining(), and nothing else after it).
#
# Foundry has no notion of being "logged in": --account names an encrypted
# keystore file and the password is entered per invocation. The keystore JSON
# stores only {crypto, id, version} -- no address field -- so the ONLY way to
# know which address it controls is to decrypt it. That is what this does: it
# derives the address from the keystore, reads owner() off the live hook, and
# compares them.
#
# Getting this wrong is unrecoverable in one direction: startMining() is
# owner-gated with no on-chain deadline and no transfer path, so if the keystore
# is not the owner the 10.5M mining allocation can never be armed.
#
#   scripts/check-owner-key.sh [account-name]
set -euo pipefail

ACCOUNT=${1:-${BITHOOK_ACCOUNT:-bithook-deployer}}
HOOK=${BITHOOK_HOOK:-0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44}
RPC=${BITHOOK_RPC:-https://ethereum-rpc.publicnode.com}
KEYSTORE="${HOME}/.foundry/keystores/${ACCOUNT}"

export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

fail() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; exit 1; }
ok()   { printf '\033[32mOK\033[0m    %s\n' "$1"; }
info() { printf '      %s\n' "$1"; }

echo "==> keystore"
[ -f "$KEYSTORE" ] || fail "no keystore named '$ACCOUNT' (looked in \$HOME/.foundry/keystores)"
ok "found keystore '$ACCOUNT'"

echo "==> deriving address (you will be asked for the keystore password)"
KEY_ADDR=$(cast wallet address --account "$ACCOUNT") \
  || fail "could not decrypt keystore -- wrong password?"
ok "keystore controls $KEY_ADDR"

echo "==> live contract"
OWNER=$(cast call "$HOOK" 'owner()(address)' --rpc-url "$RPC") \
  || fail "could not reach $RPC"
info "hook owner() = $OWNER"

# cast prints checksummed addresses, but normalise anyway so a case difference
# can never produce a false mismatch.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
[ "$(lower "$KEY_ADDR")" = "$(lower "$OWNER")" ] \
  || fail "keystore is NOT the owner -- do not send owner-only calls with it"
ok "keystore IS the hook owner"

echo "==> readiness"
NONCE=$(cast nonce "$KEY_ADDR" --rpc-url "$RPC")
BAL=$(cast balance "$KEY_ADDR" --rpc-url "$RPC")
MSTART=$(cast call "$HOOK" 'miningStart()(uint256)' --rpc-url "$RPC")
info "nonce        $NONCE"
info "balance      $(cast from-wei "$BAL") ETH"

# startMining() measured at ~114k gas; 300k at 5 gwei is a generous ceiling that
# still passes on a quiet chain and warns early on a busy one.
#
# Compared via python, not [ -lt ]: bash arithmetic is 64-bit signed, which caps
# at ~9.22e18 wei -- a balance over 9.22 ETH would silently overflow and could
# report a rich account as underfunded.
NEED=1500000000000000
if python3 -c "import sys; sys.exit(0 if int('$BAL') < int('$NEED') else 1)"; then
  printf '\033[33mWARN\033[0m  balance is under %s ETH -- thin for owner calls\n' \
    "$(cast from-wei $NEED)"
else
  ok "balance covers an owner call with room to spare"
fi

if [ "$MSTART" = "0" ]; then
  ok "miningStart = 0 (not yet armed -- startMining() is still pending)"
else
  printf '\033[33mWARN\033[0m  miningStart = %s -- mining is ALREADY armed, do not call again\n' "$MSTART"
fi

echo
echo "Signing is per-command: this proves the keystore is the owner, it does not"
echo "leave you authenticated. Every owner call re-prompts for the password."
