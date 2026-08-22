import { createPublicClient, fallback, getAddress, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

/** Interfold (FOLD) on Ethereum mainnet, and the block it was deployed in. */
const TOKEN = "0xE172e9B6cfBeeB5593bDcE3f077356FDb33af904";
const DEPLOY_BLOCK = 25473449n;
// Mirrors CoinGecko's own supply endpoint. They poll every 30 min, so the
// shared cache expires just before that while the CDN absorbs everything else.
const CACHE_CONTROL = "max-age=30, public, must-revalidate, s-maxage=1500";
const ONE = 10n ** 18n;
/** Parallelism for the chunked log scan. Sequential chunks blow the 30s limit. */
const LOG_CONCURRENCY = Number(process.env.LOG_CONCURRENCY ?? 8);

const abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function lockedBalanceOf(address) view returns (uint256)",
  "event ActiveLockUpdated(address indexed account, bytes32 indexed policyId, uint256 amount)",
  "event AllocationMinted(address indexed recipient, uint256 amount, bytes32 indexed policyId, bytes32 indexed label)",
]);
const events = abi.filter((x) => x.type === "event");

/** RPC_URL may hold several comma-separated URLs; the extras are fallbacks. */
function rpcUrls() {
  return (process.env.RPC_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
}

function makeClient(urls) {
  return createPublicClient({
    chain: mainnet,
    // No HTTP-level batching: some providers reject the large combined bodies
    // it produces. Multicall already keeps the request count low.
    transport: fallback(urls.map((url) => http(url, { retryCount: 3, timeout: 20_000 })), { rank: false }),
    batch: { multicall: { batchSize: 1024, wait: 16 } },
  });
}

/**
 * Strip anything secret out of text before it is logged.
 *
 * viem embeds the full request URL in every transport error, and our RPC URL
 * carries the provider API key in its path. That must never reach a log line,
 * let alone an HTTP response on a public endpoint.
 */
function redact(text) {
  let out = String(text ?? "");
  for (const url of rpcUrls()) {
    out = out.split(url).join("[rpc-url-redacted]");
    try {
      const { origin } = new URL(url);
      // Also catch the URL with a path appended, e.g. ".../v2/KEY/extra".
      out = out.replace(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\S*`, "g"), "[rpc-url-redacted]");
    } catch {}
  }
  return out;
}

/** Run tasks with bounded concurrency, preserving order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

/**
 * Every account that has ever held a lock, from the contract's own events.
 *
 * Every code path that creates or increases a lock routes through
 * `_addOrIncrementLock`, which emits ActiveLockUpdated naming the account, so
 * this set is complete. Locks are never transferred to a third party.
 *
 * Asks for the whole range at once, which a decent RPC answers in a single
 * request, and shrinks the window if the provider caps eth_getLogs (by block
 * range or by response size). The retry chunks run in parallel, so hitting the
 * cap costs a little latency rather than a function timeout.
 */
async function lockedAccounts(client, head) {
  const span = head - DEPLOY_BLOCK + 1n;
  const configured = process.env.LOG_CHUNK_BLOCKS;
  let step = BigInt(configured ?? span);

  for (;;) {
    const ranges = [];
    for (let start = DEPLOY_BLOCK; start <= head; start += step) {
      const end = start + step - 1n > head ? head : start + step - 1n;
      ranges.push([start, end]);
    }
    try {
      const batches = await mapLimit(ranges, LOG_CONCURRENCY, ([fromBlock, toBlock]) =>
        client.getLogs({ address: TOKEN, events, fromBlock, toBlock }),
      );
      const accounts = new Set();
      for (const logs of batches) {
        for (const log of logs) {
          const who = log.args.account ?? log.args.recipient;
          if (who) accounts.add(getAddress(who));
        }
      }
      return [...accounts];
    } catch (err) {
      if (step <= 25n) throw err; // provider is unusable at any window size
      step = step / 4n > 25n ? step / 4n : 25n; // provider capped us — back off
    }
  }
}

/**
 * The whole calculation:
 *
 *   total supply = totalSupply()
 *   circulating  = totalSupply() - every locked token on the chain
 *
 * The contract enforces its own vesting, so `lockedBalanceOf` already accounts
 * for each unlock curve at the current block timestamp. Nothing to configure,
 * no wallet list to maintain.
 *
 * `lockedBalanceOf` is the lock *schedule* principal and is deliberately NOT
 * capped at the account's balance: when an account bonds, its tokens move to
 * BONDING_REGISTRY (0x0ec90465095C21830BEcED07e032809A2Bd2915F) while its lock
 * stays behind, so locked can legitimately exceed balanceOf. Subtracting the
 * full locked amount is what keeps those bonded tokens out of circulating —
 * the registry itself holds them with no lock of its own, so capping at
 * balanceOf (or using `transferableBalanceOf`, which nets out bonding) would
 * silently count bonded tokens as circulating.
 */
async function readSupply() {
  const urls = rpcUrls();
  if (!urls.length) throw new Error("RPC_URL is not set");
  const client = makeClient(urls);

  const head = await client.getBlockNumber();
  const accounts = await lockedAccounts(client, head);

  const [totalSupply, lockedEach] = await Promise.all([
    client.readContract({ address: TOKEN, abi, functionName: "totalSupply", blockNumber: head }),
    client.multicall({
      contracts: accounts.map((address) => ({ address: TOKEN, abi, functionName: "lockedBalanceOf", args: [address] })),
      allowFailure: false,
      blockNumber: head,
    }),
  ]);

  const locked = lockedEach.reduce((a, b) => a + b, 0n);
  const circulating = totalSupply - locked;
  if (circulating < 0n || circulating > totalSupply) {
    throw new Error(`Sanity check failed: circulating=${circulating} totalSupply=${totalSupply}`);
  }
  return { totalSupply, circulating };
}

/** BigInt wei -> plain decimal token string, no exponent, no trailing zeros. */
function format(wei) {
  const whole = wei / ONE;
  const frac = (wei % ONE).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Builds an endpoint matching CoinGecko's own supply API shape:
 * `{"result":"<decimal string>"}`, publicly readable, no authentication.
 *
 * The value is a JSON *string*, not a number, exactly as CoinGecko does it.
 * That is not cosmetic: 326648349.104517411668 has 21 significant digits and
 * would silently lose the last few if a consumer parsed it as a double.
 */
export function endpoint(pick) {
  return async (_req, res) => {
    try {
      const value = pick(await readSupply());
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", CACHE_CONTROL);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).send(JSON.stringify({ result: format(value) }));
    } catch (err) {
      // Details go to the server log only. The response is deliberately
      // generic: this endpoint is public, and upstream errors quote the RPC
      // URL, which carries our provider API key.
      console.error("supply read failed:", redact(err?.stack ?? err?.message ?? err));
      // Never serve a wrong number. A 5xx makes CoinGecko retry and keep the
      // last good value; a fallback guess would silently become the truth.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.status(503).send(JSON.stringify({ error: "supply temporarily unavailable" }));
    }
  };
}
