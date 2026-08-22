import { createPublicClient, fallback, getAddress, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

/** Interfold (FOLD) on Ethereum mainnet, and the block it was deployed in. */
const TOKEN = "0xE172e9B6cfBeeB5593bDcE3f077356FDb33af904";
const DEPLOY_BLOCK = 25473449n;
// Mirrors CoinGecko's own supply endpoint. They poll every 30 min, so the
// shared cache expires just before that while the CDN absorbs everything else.
const CACHE_CONTROL = "max-age=30, public, must-revalidate, s-maxage=1500";
const ONE = 10n ** 18n;

const abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function lockedBalanceOf(address) view returns (uint256)",
  "event ActiveLockUpdated(address indexed account, bytes32 indexed policyId, uint256 amount)",
  "event AllocationMinted(address indexed recipient, uint256 amount, bytes32 indexed policyId, bytes32 indexed label)",
]);
const events = abi.filter((x) => x.type === "event");

/** RPC_URL may hold several comma-separated URLs; the extras are fallbacks. */
function makeClient() {
  const urls = (process.env.RPC_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (!urls.length) {
    throw new Error("RPC_URL is not set. Copy .env.example to .env and add an Ethereum mainnet RPC URL.");
  }
  return createPublicClient({
    chain: mainnet,
    // No HTTP-level batching: some providers reject the large combined bodies
    // it produces. Multicall already keeps the request count low.
    transport: fallback(urls.map((url) => http(url, { retryCount: 3, timeout: 20_000 })), { rank: false }),
    batch: { multicall: { batchSize: 1024, wait: 16 } },
  });
}

/**
 * Every account that has ever held a lock, from the contract's own events.
 *
 * Asks for the whole range at once, which a decent RPC answers in a single
 * request, and shrinks the window if the provider caps eth_getLogs ranges
 * (they vary from 25 blocks to unlimited). So it works on any RPC unconfigured.
 */
async function lockedAccounts(client, head) {
  const accounts = new Set();
  let step = BigInt(process.env.LOG_CHUNK_BLOCKS ?? head - DEPLOY_BLOCK + 1n);

  for (let start = DEPLOY_BLOCK; start <= head; ) {
    const end = start + step - 1n > head ? head : start + step - 1n;
    try {
      const logs = await client.getLogs({ address: TOKEN, events, fromBlock: start, toBlock: end });
      for (const log of logs) {
        const who = log.args.account ?? log.args.recipient;
        if (who) accounts.add(getAddress(who));
      }
      start = end + 1n;
    } catch (err) {
      if (step <= 25n) throw err;
      step = step / 4n > 25n ? step / 4n : 25n; // provider capped us — back off
    }
  }
  return [...accounts];
}

/**
 * The whole calculation:
 *
 *   total supply    = totalSupply()
 *   unlocked supply = totalSupply() - every locked token on the chain
 *
 * The contract enforces its own vesting, so `lockedBalanceOf` already accounts
 * for each unlock curve at the current block timestamp. Nothing to configure,
 * no wallet list to maintain.
 */
async function readSupply() {
  const client = makeClient();
  const head = await client.getBlockNumber();
  const accounts = await lockedAccounts(client, head);

  const [totalSupply, lockedEach] = await Promise.all([
    client.readContract({ address: TOKEN, abi, functionName: "totalSupply" }),
    client.multicall({
      contracts: accounts.map((address) => ({ address: TOKEN, abi, functionName: "lockedBalanceOf", args: [address] })),
      allowFailure: false,
    }),
  ]);

  const locked = lockedEach.reduce((a, b) => a + b, 0n);
  const unlocked = totalSupply - locked;
  if (unlocked < 0n || unlocked > totalSupply) {
    throw new Error(`Sanity check failed: unlocked=${unlocked} totalSupply=${totalSupply}`);
  }
  return { totalSupply, unlocked };
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
 * That is not cosmetic: 326584349.104517411668 has 21 significant digits and
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
      // Never serve a wrong number. A 5xx makes CoinGecko retry and keep the
      // last good value; a fallback guess would silently become the truth.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.status(503).send(JSON.stringify({ error: err.message }));
    }
  };
}
