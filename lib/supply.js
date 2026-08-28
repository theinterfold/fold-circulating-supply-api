import { createPublicClient, fallback, getAddress, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

/** Interfold (FOLD) on Ethereum mainnet, and the block it was deployed in. */
const TOKEN = "0xE172e9B6cfBeeB5593bDcE3f077356FDb33af904";
const DEPLOY_BLOCK = 25473449n;
/**
 * Addresses whose entire FOLD balance is out of circulation, whatever its lock
 * status. Two kinds, treated identically because the reasoning is the same —
 * the tokens are not on the open market and cannot be sold from where they sit:
 *
 *   Treasury Safes. An unlocked Foundation or Gnosis Guild allocation is still
 *   treasury while it sits in the Safe; it enters circulation only when it is
 *   actually transferred out.
 *
 *   Escrow contracts. veLocker holds FOLD escrowed for 30 days, and
 *   BONDING_REGISTRY holds FOLD bonded to ciphernodes. Both are encumbered by
 *   the contract that holds them, independently of any vesting lock.
 *
 * Not `.map(getAddress)`: map passes the index as viem's second argument,
 * which it reads as a chainId and switches to EIP-1191 checksumming.
 */
const NON_CIRCULATING = [
  "0x12BEEF35025841EFccb77D6EE40df86400Fdb4bB", // Gnosis Guild DAO Safe
  "0x5429D8c7fD14023f3c414126F94BbE25A05fC018", // Interfold Foundation Safe
  "0x8B43b2852fc5031D01DDfCDF702973D93A2FF593", // Interfold Foundation Safe
  "0x71360F335e4Ec9c010e29bA7171bc62c9B4c1F12", // veLocker escrow
  "0x0ec90465095C21830BEcED07e032809A2Bd2915F", // ciphernode bonding registry
].map((address) => getAddress(address));
const IS_NON_CIRCULATING = new Set(NON_CIRCULATING);
// Mirrors CoinGecko's own supply endpoint. They poll every 30 min, so the
// shared cache expires just before that while the CDN absorbs everything else.
const CACHE_CONTROL = "max-age=30, public, must-revalidate, s-maxage=1500";
const ONE = 10n ** 18n;
/** Parallelism for the chunked log scan. Sequential chunks blow the 30s limit. */
const LOG_CONCURRENCY = Number(process.env.LOG_CONCURRENCY ?? 8);

const abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function lockedBalanceOf(address) view returns (uint256)",
  "event ActiveLockUpdated(address indexed account, bytes32 indexed policyId, uint256 amount)",
  "event AllocationMinted(address indexed recipient, uint256 amount, bytes32 indexed policyId, bytes32 indexed label)",
]);
const events = abi.filter((x) => x.type === "event");

/** A problem with our own configuration, as opposed to an upstream failure. */
class ConfigError extends Error {}

/**
 * RPC_URL may hold several comma-separated URLs; the extras are fallbacks.
 *
 * Surrounding quotes are stripped: pasting `"https://..."` into the Vercel
 * dashboard is an easy mistake and the quotes become part of the value.
 */
function rpcUrls() {
  return (process.env.RPC_URL ?? "")
    .split(",")
    .map((u) => u.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

/**
 * Describe a malformed entry without echoing it — the value may be, or may
 * contain, the provider API key.
 */
function describeBadUrl(u) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(u);
  if (!scheme) return `an entry of ${u.length} chars is missing an https:// scheme`;
  return `an entry of ${u.length} chars has scheme "${scheme[1]}" but could not be parsed as a URL`;
}

/** Validate RPC_URL up front so misconfiguration is reported as such. */
function validatedRpcUrls() {
  const urls = rpcUrls();
  if (!urls.length) throw new ConfigError("RPC_URL is not set");
  const problems = [];
  for (const u of urls) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      problems.push(describeBadUrl(u));
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      problems.push(`an entry uses unsupported protocol "${parsed.protocol}"`);
    }
  }
  if (problems.length) throw new ConfigError(`RPC_URL is invalid: ${problems.join("; ")}`);
  return urls;
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
 * Strip the secret out of text before it is logged.
 *
 * viem embeds the full request URL in every transport error, and our RPC URL
 * carries the provider API key in its path. That must never reach a log line,
 * let alone an HTTP response on a public endpoint.
 *
 * The host is kept and only the path/query masked: the hostname is not secret,
 * and knowing *which* provider failed is most of the value of the log line.
 */
function redact(text) {
  let out = String(text ?? "");
  for (const url of rpcUrls()) {
    let masked = "[rpc-url-redacted]";
    try {
      masked = `${new URL(url).origin}/[key-redacted]`;
    } catch {}
    out = out.split(url).join(masked);
    try {
      const origin = new URL(url).origin;
      const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Also catch the URL with a path appended, e.g. ".../v2/KEY/extra".
      out = out.replace(new RegExp(`${escaped}(?!/\\[key-redacted\\])\\S*`, "g"), masked);
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
 *   circulating  = totalSupply()
 *                - everything held by a NON_CIRCULATING address
 *                - every locked token still held by its own owner
 *
 * The contract enforces its own vesting, so `lockedBalanceOf` already accounts
 * for each unlock curve at the current block timestamp: no vesting wallet can
 * be missed or go stale, and nothing has to run when an unlock happens.
 *
 * The one subtlety is that the two exclusions overlap. `lockedBalanceOf` is the
 * lock *schedule* principal and is NOT capped at the account's balance: when an
 * account bonds or escrows, its tokens move to BONDING_REGISTRY or veLocker
 * while its lock stays behind, so locked can legitimately exceed balanceOf.
 * Those contracts' balances are excluded here in full, so the part of a lock
 * whose tokens have already left the account is excluded there — counting it
 * again as locked would subtract the same tokens twice and understate
 * circulating by ~128k FOLD. Hence `min(lockedBalanceOf, balanceOf)`: exclude
 * only the locked tokens the account still physically holds.
 *
 * The mirror image of the same rule covers the ~248k FOLD that is bonded or
 * escrowed while carrying no lock at all — unlocked tokens the old formula
 * counted as circulating. Excluding the holding contract's balance catches it
 * regardless of lock status.
 *
 * Because every exclusion is a live balance, tokens become circulating the
 * moment they leave the Safe or the escrow, with nothing to update here.
 */
async function readSupply() {
  const client = makeClient(validatedRpcUrls());

  const head = await client.getBlockNumber();
  // A NON_CIRCULATING address is excluded by balance, so its lock must not be
  // counted as well — that is the same double count in its other form.
  const accounts = (await lockedAccounts(client, head)).filter((a) => !IS_NON_CIRCULATING.has(a));

  const call = (functionName, address) => ({ address: TOKEN, abi, functionName, args: [address] });
  const [totalSupply, lockedEach, heldEach, excludedEach] = await Promise.all([
    client.readContract({ address: TOKEN, abi, functionName: "totalSupply", blockNumber: head }),
    client.multicall({
      contracts: accounts.map((address) => call("lockedBalanceOf", address)),
      allowFailure: false,
      blockNumber: head,
    }),
    client.multicall({
      contracts: accounts.map((address) => call("balanceOf", address)),
      allowFailure: false,
      blockNumber: head,
    }),
    client.multicall({
      contracts: NON_CIRCULATING.map((address) => call("balanceOf", address)),
      allowFailure: false,
      blockNumber: head,
    }),
  ]);

  const locked = lockedEach.reduce((sum, lock, i) => sum + (lock < heldEach[i] ? lock : heldEach[i]), 0n);
  const excluded = excludedEach.reduce((a, b) => a + b, 0n);

  const circulating = totalSupply - locked - excluded;
  if (circulating < 0n || circulating > totalSupply) {
    throw new Error(
      `Sanity check failed: circulating=${circulating} totalSupply=${totalSupply} locked=${locked} excluded=${excluded}`,
    );
  }
  return { totalSupply, circulating, locked, excluded };
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
      // A ConfigError is our own misconfiguration and its message is built to
      // contain no secret, so it is safe — and far more useful — to say so
      // plainly. Anything else may quote the RPC URL, which carries our
      // provider API key, so the detail goes to the log and the response stays
      // generic. This endpoint is public: whatever it returns is public.
      const isConfig = err instanceof ConfigError;
      console.error("supply read failed:", isConfig ? err.message : redact(err?.stack ?? err?.message ?? err));
      // Never serve a wrong number. A 5xx makes CoinGecko retry and keep the
      // last good value; a fallback guess would silently become the truth.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.status(503).send(
        JSON.stringify({ error: isConfig ? `server misconfigured: ${err.message}` : "supply temporarily unavailable" }),
      );
    }
  };
}
