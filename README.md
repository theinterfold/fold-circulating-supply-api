# FOLD Supply API

Two endpoints for CoinGecko, for **Interfold (FOLD)** on Ethereum mainnet
(`0xE172e9B6cfBeeB5593bDcE3f077356FDb33af904`).

| Endpoint | Returns |
|---|---|
| `GET /api/total-supply` | `{"result":"1200000000"}` |
| `GET /api/circulating-supply` | `{"result":"320104581.663839175007917927"}` |

This matches the shape of CoinGecko's own reference endpoint,
`api.coingecko.com/api/v3/supply/eth`, which the integration guidelines cite as
the example: `application/json`, a single `result` key, decimals included, and
the value as a **string**.

The string is not cosmetic. `320104581.663839175007917927` carries 27 significant
digits; parsed as a JSON number it silently becomes `320104581.6638392`, losing
most of them. CoinGecko returns strings for the same reason.

## Deploying

**One thing to change: the RPC URL.**

Set it as a Vercel environment variable — do not create a local `.env` holding a
real key:

```bash
vercel env add RPC_URL production
vercel env add RPC_URL preview
vercel env add RPC_URL development
vercel deploy --prod
```

Or in the dashboard: **Project → Settings → Environment Variables**. Nothing
else needs touching. For local `vercel dev`, run `vercel env pull` (it writes a
gitignored `.env.local`) and delete that file when you are done.

If `RPC_URL` is unset the endpoints return `503` on every request, so set it
*before* giving the URL to CoinGecko.

The RPC must serve `eth_getLogs` across a ~350k block range. Free tiers from
Alchemy, Infura, Ankr and drpc all do. If the provider caps the range or the
response size, the scan shrinks its window and retries **in parallel**, so a cap
costs a little latency rather than a function timeout. Measured: whole range in
one request ~1.5s; forced down to 500-block windows, ~7.9s — same answer to the
wei. (Alchemy's real limit is 10,000 logs per response, not a block range.)

`RPC_URL` accepts several comma-separated URLs and uses the extras as automatic
fallbacks. Surrounding quotes and stray whitespace are tolerated. Of the
unauthenticated public endpoints, `https://eth.drpc.org` works as a fallback;
`ethereum-rpc.publicnode.com` and `rpc.ankr.com/eth` do not.

If `RPC_URL` is missing or malformed the endpoint says so directly —
`{"error":"server misconfigured: RPC_URL is invalid: an entry of 55 chars is
missing an https:// scheme"}` — describing the value without echoing it, since
it carries the API key. Every other failure returns the generic message.

## The whole calculation

```
  total supply    = totalSupply()
- non-circulating = Σ balanceOf(treasury Safe or escrow contract)
- locked          = Σ min(lockedBalanceOf(account), balanceOf(account))
  ─────────────────────────────────────────────────────────────────────
= circulating supply
```

**Vesting takes care of itself.** The token contract enforces its own.
`lockedBalanceOf(address)` returns that account's still-locked amount evaluated
against its unlock curve **at the current block timestamp**, so no vesting
wallet can be missed or go stale and nothing has to run when an unlock happens.
The curves release linearly, so the number rises continuously rather than in
steps. All locks end at `NO_MORE_LOCKS` (2030-09-17). Accounts are found from
the contract's own `ActiveLockUpdated` and `AllocationMinted` logs, so locks
created in future are picked up with no redeploy.

**Held out of circulation.** These addresses are excluded by their **whole**
balance, lock or no lock:

| Address | What it is | Why it is not circulating |
|---|---|---|
| `0x12BEEF35025841EFccb77D6EE40df86400Fdb4bB` | Gnosis Guild DAO Safe | treasury |
| `0x5429D8c7fD14023f3c414126F94BbE25A05fC018` | Interfold Foundation Safe | treasury |
| `0x8B43b2852fc5031D01DDfCDF702973D93A2FF593` | Interfold Foundation Safe | treasury |
| `0x71360F335e4Ec9c010e29bA7171bc62c9B4c1F12` | veLocker escrow | escrowed, 30-day lock |
| `0x0ec90465095C21830BEcED07e032809A2Bd2915F` | ciphernode bonding registry | bonded |

An Interfold Foundation or Gnosis Guild allocation that has passed its unlock
date is still treasury while it sits in the Safe — it has not entered the open
market. Likewise, FOLD in veLocker or bonded to a ciphernode cannot be sold from
where it sits, whether or not it was ever under a vesting lock.

The escrow *voting* contracts hold no FOLD themselves and are deliberately not
listed: the IVotes adapter `0x8f141B4D294d39e7D1530916A3eD65B3970C6FEc` and
BondedVotes `0x028deEA644258c78b1B5B2eacF469F5D781Fb43E` both have a zero
balance — the tokens live in veLocker and the registry above.

**Why the lock sum is capped at the balance.** The two exclusions overlap.
`lockedBalanceOf` is the lock *schedule* principal and is not capped at the
account's balance: when an account bonds or escrows, its tokens move to the
registry or veLocker while its lock stays behind, so locked can exceed
`balanceOf`. Those contract balances are now excluded in full, so the part of a
lock whose tokens have already left the account is excluded there —
counting it again would subtract the same tokens twice. Measured on chain:
**128,000 FOLD** of locked balance sits in the registry or veLocker rather than
with its owner, and `min(locked, balance)` is what keeps it from being
subtracted twice.

The mirror image is the reason for the exclusion in the first place:
**248,147 FOLD** is bonded or escrowed while carrying *no* lock at all, and the
previous formula counted it as circulating.

Because every exclusion is a **live balance**, tokens count as circulating the
moment they leave a Safe or an escrow — nothing to update, no approval step.
The flip side: a transfer out of a Safe that is not a sale (moving between
Safes, paying a vendor in kind) counts as circulating from the moment it lands.
If a destination should stay excluded, add it to `NON_CIRCULATING` in
`lib/supply.js`.

**Nothing is burned.** `totalSupply()` equals `MAX_SUPPLY` (1,200,000,000)
exactly and the contract has no burn function, so supply cannot shrink.

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
If it is on, CoinGecko receives a Vercel login page instead of the number and
the integration fails with no obvious error.

This project is currently set to `ssoProtection: all_except_custom_domains`
(Vercel Authentication, "Standard Protection" — the default, and it applies on
Hobby too). Under that setting **every `*.vercel.app` URL is behind SSO,
including production**; only a custom domain is exempt. So either:

- attach a custom domain (e.g. `api.interfold.xyz`) and give CoinGecko that, or
- set **Project → Settings → Deployment Protection → Vercel Authentication** to
  *Disabled*.

Then verify from outside your session — logged out, or in a private window —
before submitting:

```bash
curl -s https://<your-domain>/api/circulating-supply \
  -H 'X-Requested-With: com.coingecko' \
  -H 'User-Agent: CoinGecko +https://coingecko.com/'
```

That must return the JSON, not HTML. Those are the exact headers CoinGecko
sends; if you later add Vercel Firewall rules or bot protection, allow them.

## Correctness

- Both figures are read at one pinned block height, so they always reconcile.
- A sanity check rejects any result outside `0 ≤ circulating ≤ totalSupply`, and
  its message carries the locked and non-circulating components for diagnosis.
- **On any RPC failure the endpoint returns `503`, never a guess.** CoinGecko
  retries and keeps the last good value; a fallback number would silently become
  the published truth.
- The 503 body is deliberately generic (`supply temporarily unavailable`).
  Upstream errors quote the RPC URL, which carries the provider API key, so the
  detail goes to the server log with the URL redacted — never to the response.
  This endpoint is public; anything it returns is public.
- The value is returned as a string, so no precision is lost in transit.

Verified against chain on 2026-08-22: every one of the 8,114 addresses that has
ever appeared in a `Transfer` was probed for a lock, and the 638 accounts found
via `ActiveLockUpdated`/`AllocationMinted` capture all 138 with a non-zero lock —
the event scan misses nothing. `DEPLOY_BLOCK` was confirmed by binary search.
Chunked and unchunked scans agree exactly.

Re-read on 2026-08-27 with the exclusions in place, at block 25845224:

```
total supply     1,200,000,000
non-circulating    715,276,411.651992994992082073   (Safes 714,900,264.65 + veLocker 24,042 + bonded 352,105)
locked & held      164,619,006.68416783
circulating        320,104,581.663839175007917927
```

That is exactly 248,147 FOLD below the treasury-only figure — the bonded and
escrowed balance carrying no lock — confirming the two exclusions compose
without double counting.

## Layout

```
api/total-supply.js         endpoint (3 lines)
api/circulating-supply.js   endpoint (3 lines)
lib/supply.js               the calculation
```
