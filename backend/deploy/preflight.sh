#!/usr/bin/env bash
# Preflight check for the $PLAGUE backend. Run on the droplet from the backend folder:
#   bash deploy/preflight.sh
# Prints PASS / WARN / FAIL for each check. Changes nothing.
set -u
cd "$(dirname "$0")/.." || exit 1

G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'
fails=0; warns=0
pass(){ echo "  ${G}PASS${N}  $*"; }
warn(){ echo "  ${Y}WARN${N}  $*"; warns=$((warns+1)); }
fail(){ echo "  ${R}FAIL${N}  $*"; fails=$((fails+1)); }
section(){ echo; echo "${B}$*${N}"; }

envval(){ grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e 's/[[:space:]]*$//'; }
is_addr(){ [[ "$1" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; }

section "1. Settings (.env)"
if [ ! -f .env ]; then fail ".env is missing (cp .env.example .env)"; else
  RPC=$(envval RPC_URL); MINT=$(envval MINT); DEV=$(envval DEV_WALLET); PRIZE=$(envval PRIZE_WALLET)
  DOMAIN=$(envval API_DOMAIN); CORS=$(envval CORS_ORIGINS); EPOCH=$(envval EPOCH_START)
  [[ "$RPC" == https://* ]] && pass "RPC_URL set (${RPC%%\?*}?…)" || fail "RPC_URL missing or not https"
  [[ "$RPC" == *api-key=* && "$RPC" != *YOUR_KEY* ]] || warn "RPC_URL has no API key; public RPCs rate-limit quickly"
  if is_addr "$MINT"; then [[ "$MINT" == PLAGUEdemo* ]] && fail "MINT is the demo mint" || pass "MINT $MINT"; else fail "MINT missing or not a Solana address"; fi
  is_addr "$DEV" && pass "DEV_WALLET $DEV" || fail "DEV_WALLET missing or invalid"
  is_addr "$PRIZE" && pass "PRIZE_WALLET $PRIZE" || fail "PRIZE_WALLET missing or invalid"
  [ -n "$DEV" ] && [ "$DEV" = "$PRIZE" ] && fail "PRIZE_WALLET is the same as DEV_WALLET; use a separate wallet"
  [ "$DOMAIN" = "api.plague.run" ] && pass "API_DOMAIN api.plague.run" || warn "API_DOMAIN is '$DOMAIN' (expected api.plague.run)"
  [[ "$CORS" == *plague.run* ]] && pass "CORS_ORIGINS includes plague.run" || warn "CORS_ORIGINS doesn't include https://plague.run"
  if [[ "$EPOCH" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && date -d "$EPOCH" >/dev/null 2>&1; then
    pass "EPOCH_START $EPOCH ($(date -u -d "$EPOCH" '+%a %d %b %H:%M UTC'))"
  else fail "EPOCH_START missing or not like 2026-10-10T18:00:00Z"; fi
  PO=$(envval POOL_OWNERS); [ -z "$PO" ] && pass "POOL_OWNERS empty (Meteora defaults)" || warn "POOL_OWNERS set: make sure it still includes the two Meteora defaults"
  FH=$(envval FEE_CLAIM_HOURS); [ "${FH:-0}" != "0" ] && pass "Fee auto-claim every ${FH}h" || warn "FEE_CLAIM_HOURS is 0: fees won't be claimed automatically"
fi

section "2. Live mode"
if [ -f docker-compose.override.yml ] && grep -q "scripts/demo.js" docker-compose.override.yml; then
  fail "docker-compose.override.yml still runs the demo. Delete the 'command:' line, then: docker compose up -d"
else pass "Override doesn't force demo mode"; fi
if [ -f docker-compose.override.yml ] && grep -q "bundled-caddy" docker-compose.override.yml; then pass "Bundled Caddy disabled (using the droplet's Caddy)"
else warn "No override disabling the bundled Caddy; it will clash with the system Caddy on ports 80/443"; fi

section "3. Prize keypair"
KP=secrets/prize-keypair.json
if [ ! -f "$KP" ]; then fail "$KP missing (needed for fee claims and payouts)"; else
  perms=$(stat -c %a "$KP"); [ "$perms" = "600" ] && pass "$KP permissions 600" || warn "$KP permissions are $perms; run: chmod 600 $KP"
fi

section "4. Container"
if ! command -v docker >/dev/null; then fail "Docker not installed"; else
  state=$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1=="api"{print $2}')
  [ "$state" = "running" ] && pass "api container running" || fail "api container is '${state:-not created}' (docker compose up -d --build)"
  cid=$(docker compose ps -q api 2>/dev/null)
  if [ -n "$cid" ]; then
    restarts=$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null)
    [ "$restarts" = "0" ] && pass "No crash restarts" || warn "Container restarted $restarts times; check: docker compose logs --tail=50 api"
  fi
  if [ "$state" = "running" ] && [ -f "$KP" ]; then
    kp=$(docker compose exec -T api node -e "const {Keypair}=require('@solana/web3.js');const k=Keypair.fromSecretKey(Uint8Array.from(require('/app/secrets/prize-keypair.json')));console.log(k.publicKey.toBase58())" 2>/dev/null | tail -1)
    if [ -z "$kp" ]; then fail "Prize keypair can't be read inside the container (bad JSON?)"
    elif [ "$kp" = "${PRIZE:-}" ]; then pass "Prize keypair matches PRIZE_WALLET"
    else fail "Prize keypair is $kp but PRIZE_WALLET is ${PRIZE:-empty}"; fi
  fi
fi

section "5. API (local)"
H=$(curl -s -m 5 http://127.0.0.1:8080/api/health || true)
if [[ "$H" == *'"ok":true'* ]]; then
  pass "Health OK"
  [[ "$H" == *'"worker":true'* ]] && pass "Indexer running (live mode)" || fail "Indexer is off: still in demo mode"
  [[ -n "${MINT:-}" && "$H" == *"$MINT"* ]] && pass "Server is watching your MINT" || fail "Server is watching a different mint: $H"
else fail "No answer on 127.0.0.1:8080 ($H)"; fi
G1=$(curl -s -m 8 http://127.0.0.1:8080/api/graph | head -c 400 || true)
[[ "$G1" == *'"nodes"'* ]] && pass "Graph endpoint returns data" || fail "Graph endpoint not returning data"

section "6. Solana RPC"
if [ -n "${RPC:-}" ]; then
  slot=$(curl -s -m 8 "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | grep -o '"result":[0-9]*' | cut -d: -f2)
  [ -n "$slot" ] && pass "RPC reachable (slot $slot)" || fail "RPC not answering; check RPC_URL / Helius key"
  if [ -n "$slot" ] && is_addr "${MINT:-}"; then
    sup=$(curl -s -m 8 "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTokenSupply\",\"params\":[\"$MINT\"]}")
    if [[ "$sup" == *uiAmountString* ]]; then pass "Token exists on-chain (supply $(echo "$sup" | grep -o '"uiAmountString":"[^"]*"' | cut -d'"' -f4))"
    else warn "Token doesn't exist on-chain yet (normal before launch)"; fi
  fi
fi

section "7. Public access"
ips=" $(hostname -I 2>/dev/null) "
dns=$(getent hosts api.plague.run | awk '{print $1}' | head -1)
if [ -z "$dns" ]; then fail "api.plague.run doesn't resolve; add an A record → this droplet's IP"
elif [[ "$ips" == *" $dns "* ]]; then pass "api.plague.run → $dns (this droplet)"
else fail "api.plague.run → $dns, but this droplet's IPs are:$ips"; fi
grep -q "api.plague.run" /etc/caddy/Caddyfile 2>/dev/null && pass "Caddy has an api.plague.run block" || fail "No api.plague.run block in /etc/caddy/Caddyfile"
PH=$(curl -s -m 10 https://api.plague.run/api/health || true)
[[ "$PH" == *'"ok":true'* ]] && pass "https://api.plague.run/api/health OK (certificate valid)" || fail "https://api.plague.run not answering over HTTPS"
SG=$(curl -s -m 10 https://plague.run/api/health || true)
[[ "$SG" == *'"ok":true'* ]] && pass "plague.run → Vercel → API rewrite works" || warn "https://plague.run/api/health doesn't reach the API yet (Vercel deploy / vercel.json / domain)"
SITE=$(curl -s -m 10 https://plague.run/ | grep -o '<title>[^<]*' | head -1)
[[ "$SITE" == *PLAGUE* ]] && pass "plague.run serves the site" || warn "plague.run isn't serving the site yet"

section "8. Fee claiming (preview, sends nothing)"
if [ "${state:-}" = "running" ] && [ -f "$KP" ]; then
  out=$(docker compose exec -T api node scripts/claim-fees.js 2>&1 | grep -v bigint | tail -8)
  echo "$out" | sed 's/^/        /'
  [[ "$out" == *"'error'"* ]] && warn "A fee source returned an error (see above)"
  [[ "$out" == *"'skipped'"* ]] && warn "Prize wallet isn't the pool creator yet: run scripts/transfer-creator.js after launch"
else warn "Skipped (container or keypair missing)"; fi

section "9. Housekeeping"
free=$(df -Pm . | awk 'NR==2{print $4}'); [ "$free" -gt 2000 ] && pass "Disk free ${free} MB" || warn "Only ${free} MB disk free"
crontab -l 2>/dev/null | grep -q "plague.db" && pass "Daily database backup in cron" || warn "No database backup in cron (see README)"
ufw status 2>/dev/null | grep -q "Status: active" && ufw status | grep -q 8080 && warn "Port 8080 is open in the firewall; close it: ufw delete allow 8080" || pass "Port 8080 not exposed publicly"

echo
if [ $fails -eq 0 ]; then echo "${G}${B}Ready.${N} $warns warning(s)."; else echo "${R}${B}$fails problem(s) to fix${N}, $warns warning(s)."; fi
exit $fails
