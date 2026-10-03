#!/usr/bin/env bash
# Puts the operator keystore where cast looks for it, then runs the relayer.
#
# NOKTURN_MIRROR_KEYSTORE   the nokturn-testnet keystore JSON, raw or base64
# NOKTURN_MIRROR_PASSWORD   its password
#
# Both are Railway variables of the testnet environment only. The keystore is
# the testnet deployer, which MirrorFeed names as its immutable operator, so no
# narrower key can push. It holds nothing on mainnet.

set -euo pipefail

[ -n "${NOKTURN_MIRROR_KEYSTORE:-}" ] || { echo "NOKTURN_MIRROR_KEYSTORE is not set" >&2; exit 1; }
[ -n "${NOKTURN_MIRROR_PASSWORD:-}" ] || { echo "NOKTURN_MIRROR_PASSWORD is not set" >&2; exit 1; }

umask 077
mkdir -p "$HOME/.foundry/keystores"
# Pasted as the keystore JSON itself or as its base64. JSON starts with a brace,
# which base64 never does.
keystore="$HOME/.foundry/keystores/nokturn-testnet"
case "$NOKTURN_MIRROR_KEYSTORE" in
  \{*) printf '%s' "$NOKTURN_MIRROR_KEYSTORE" > "$keystore" ;;
  *) printf '%s' "$NOKTURN_MIRROR_KEYSTORE" | tr -d ' \n\r\t' | base64 -d > "$keystore" ;;
esac
password_file="$(mktemp)"
printf '%s' "$NOKTURN_MIRROR_PASSWORD" > "$password_file"
unset NOKTURN_MIRROR_KEYSTORE NOKTURN_MIRROR_PASSWORD

# Every MirrorFeed refuses any caller but its operator, so a wrong keystore
# would fail each push for ever. Say so once and stop.
operator="$(python3 -c 'import json; print(json.load(open("deployments/46630-fixtures.json"))["operator"])')"
signer="$(cast wallet address --account nokturn-testnet --password-file "$password_file")"
if [ "${signer,,}" != "${operator,,}" ]; then
  echo "the keystore opens as $signer, but the mirror operator is $operator. use the keystore of $operator" >&2
  exit 1
fi
echo "keystore opens as the mirror operator $signer"

# drpc for mainnet, because the relayer reads only the latest round and the
# official mainnet RPC is the one the production api already leans on.
exec python3 tools/mirror.py \
  --account nokturn-testnet \
  --password-file "$password_file" \
  --mainnet-rpc "${NOKTURN_RPC_MAINNET:-https://robinhood.drpc.org}" \
  --testnet-rpc "${NOKTURN_RPC_TESTNET:-https://rpc.testnet.chain.robinhood.com}" \
  --interval "${NOKTURN_MIRROR_INTERVAL:-60}"
