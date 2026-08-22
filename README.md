# FOLD Supply API

Two endpoints for CoinGecko, for **Interfold (FOLD)** on Ethereum mainnet
(`0xE172e9B6cfBeeB5593bDcE3f077356FDb33af904`).

| Endpoint | Returns |
|---|---|
| `GET /api/total-supply` | `{"result":"1200000000"}` |
| `GET /api/circulating-supply` | `{"result":"326584349.104517411668"}` |

This matches the shape of CoinGecko's own reference endpoint,
`api.coingecko.com/api/v3/supply/eth`, which the integration guidelines cite as
the example: `application/json`, a single `result` key, decimals included, and
the value as a **string**.

The string is not cosmetic. `326584349.104517411668` carries 21 significant
digits; parsed as a JSON number it silently becomes `326584349.1045174`, losing
five of them. CoinGecko returns strings for the same reason.

## Deploying

**One thing to change: the RPC URL.**

```bash
npm install
cp .env.example .env      # put your own RPC URL in .env
vercel deploy --prod
```

On Vercel, set `RPC_URL` under **Project → Settings → Environment Variables**
instead of using `.env`. Nothing else needs touching.

The RPC must allow `eth_getLogs` over a ~350k block range. Free tiers from
Alchemy, Infura, Ankr and drpc all do. **Unauthenticated public RPCs do not** —
every one tested either caps log ranges at 25–10,000 blocks or refuses archive
reads. `RPC_URL` accepts several comma-separated URLs and uses the extras as
automatic fallbacks.

## The whole calculation

```
  total supply     = totalSupply()
- still locked     = Σ lockedBalanceOf(account)
  ──────────────────────────────────────────
= unlocked supply
```

That is the entire thing. No wallet list, no configuration, no judgement call.

**Why it needs nothing else.** The token contract enforces its own vesting.
`lockedBalanceOf(address)` returns that account's still-locked amount evaluated
against its unlock curve **at the current block timestamp**. Every locked token
is therefore excluded automatically — no vesting wallet can be missed or go
stale. The curves release linearly, so unlocked supply rises continuously rather
than in steps, and nothing has to run when an unlock happens. All locks end at
`NO_MORE_LOCKS` (2030-09-17), after which unlocked converges to total on its own.

Accounts are found from the contract's own `ActiveLockUpdated` and
`AllocationMinted` logs, so locks created in future are picked up with no
redeploy.

**Nothing is burned.** `totalSupply()` equals `MAX_SUPPLY` (1,200,000,000)
exactly and the contract has no burn function, so supply cannot shrink.

**Bonded tokens count once.** `lockedBalanceOf` covers tokens the account
controls including any bonded elsewhere, so a locked balance can exceed a wallet
balance. Subtracting the locked total directly handles this with no double
counting.

## Refresh rate

No cron, no stored state — both numbers are read from chain on demand.
`Cache-Control` mirrors CoinGecko's own endpoint:

```
max-age=30, public, must-revalidate, s-maxage=1500
```

CoinGecko polls every 30 minutes; the 25-minute shared cache (`s-maxage=1500`)
expires just before each poll, so they always get a fresh read while the CDN
absorbs any other traffic. Set in `CACHE_CONTROL` in `lib/supply.js`.

## Meeting CoinGecko's requirements

| Requirement | Status |
|---|---|
| Simple REST endpoint, decimals included | Yes — decimal-adjusted, full precision |
| Publicly accessible, no authentication | Yes — see the deployment note below |
| No API key | Yes |
| Rate limits allowing a poll every 30 min | Yes — CDN-cached, chain reads are rare |

**The one thing that can silently break this: Vercel Deployment Protection.**
It is the Vercel equivalent of the CloudFlare warning in CoinGecko's guidelines.
Vercel Authentication guards *Preview* deployments by default, and teams on Pro
or Enterprise can enable Standard Protection which covers *Production* too. If
either applies, CoinGecko receives a login page instead of the number and the
integration fails with no obvious error.

So: give CoinGecko the **production** URL, not a preview URL, and check
**Project → Settings → Deployment Protection** is off for production. Verify
from outside your session before submitting:

```bash
curl -s https://<your-domain>/api/circulating-supply \
  -H 'X-Requested-With: com.coingecko' \
  -H 'User-Agent: CoinGecko +https://coingecko.com/'
```

That must return the JSON, not HTML. Those are the exact headers CoinGecko
sends; if you later add Vercel Firewall rules or bot protection, allow them.

## Correctness

- Both figures come from one consistent block height, so they always reconcile.
- A sanity check rejects any result outside `0 ≤ unlocked ≤ totalSupply`.
- **On any RPC failure the endpoint returns `503`, never a guess.** CoinGecko
  retries and keeps the last good value; a fallback number would silently become
  the published truth.
- The value is returned as a string, so no precision is lost in transit.

## Layout

```
api/total-supply.js         endpoint (3 lines)
api/circulating-supply.js   endpoint (3 lines)
lib/supply.js               the calculation (115 lines)
```
