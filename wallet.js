#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cli-aa-wallet-skill — a minimal Account Abstraction (ERC-4337) CLI wallet.
//
//   Signer  : Web3Auth Node SDK (Google login -> key), or a local PRIVATE_KEY.
//   Account : MetaMask Smart Account (Hybrid) via @metamask/delegation-toolkit.
//   Infra   : Pimlico bundler + paymaster on Sepolia (gasless sends).
//
// Commands: login | logout | address | balance | send | tx
// Run `node wallet.js help` for usage.
// ---------------------------------------------------------------------------

import dotenv from "dotenv";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createPublicClient,
  http,
  parseEther,
  formatEther,
  isAddress,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  createBundlerClient,
  entryPoint07Address,
} from "viem/account-abstraction";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/delegation-toolkit";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env.local") });

const SESSION_FILE = join(__dirname, ".wallet-session.json");
const CHAIN = sepolia;

// --- small helpers ---------------------------------------------------------

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function env(name, required = false) {
  const v = process.env[name];
  if (required && !v) die(`Missing ${name} in .env.local (see .env.example).`);
  return v;
}

function with0x(hex) {
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveSession(data) {
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open it manually */
  }
}

// --- signer: where the owner key comes from --------------------------------
//
// If WEB3AUTH_CLIENT_ID is set we use Web3Auth (Google login). Otherwise we
// fall back to a local PRIVATE_KEY for quick testing.

function useWeb3Auth() {
  return Boolean(process.env.WEB3AUTH_CLIENT_ID);
}

// Derive the owner private key from a Google id_token via the Web3Auth Node
// SDK. The key is reconstructed in memory per call and never written to disk.
//
// NOTE: the Web3Auth SDK changes its API fairly often. This targets the
// current "MetaMask Embedded Wallets" Node SDK (authConnectionId + idToken).
// If your installed version differs, check the latest docs:
//   https://docs.metamask.io/embedded-wallets/sdk/node/
// Get a FRESH Google id_token for every Web3Auth connect. Web3Auth rejects a
// reused JWT ("Duplicate token found"), so we never replay the cached token —
// we silently mint a new one from the saved refresh_token (no browser popup,
// and no private key stored on disk).
async function getFreshGoogleIdToken() {
  const session = loadSession();
  if (!session) die("Not logged in. Run:  node wallet.js login");

  if (session.refreshToken) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("GOOGLE_CLIENT_ID", true),
        client_secret: env("GOOGLE_CLIENT_SECRET", true),
        refresh_token: session.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const data = await res.json();
    if (!data.id_token)
      die(
        `Could not refresh Google session (${data.error || "unknown error"}). ` +
          "Run `node wallet.js login` again.",
      );
    return data.id_token;
  }

  // Fallback: a single-use id_token from login (only works for one command).
  if (session.idToken) return session.idToken;
  die("Not logged in. Run:  node wallet.js login");
}

async function deriveOwnerFromWeb3Auth() {
  const idToken = await getFreshGoogleIdToken();

  const { Web3Auth } = await import("@web3auth/node-sdk");

  const chainConfig = {
    chainNamespace: "eip155",
    chainId: "0xaa36a7", // Sepolia
    rpcTarget: env("RPC_URL", true),
    displayName: "Ethereum Sepolia",
    blockExplorerUrl: "https://sepolia.etherscan.io",
    ticker: "ETH",
    tickerName: "Ethereum",
  };

  const web3auth = new Web3Auth({
    clientId: env("WEB3AUTH_CLIENT_ID", true),
    // Must match the network your dashboard project / connection lives on.
    web3AuthNetwork: process.env.WEB3AUTH_NETWORK || "sapphire_devnet",
    chains: [chainConfig],
    defaultChainId: "0xaa36a7",
  });
  await web3auth.init();

  // connect() returns { provider, signer }. For EIP155 `signer` is an ethers
  // Wallet exposing .privateKey; the key is reconstructed in memory only.
  const result = await web3auth.connect({
    authConnectionId: env("WEB3AUTH_AUTH_CONNECTION_ID", true),
    idToken,
  });

  const pk =
    result?.signer?.privateKey ??
    (await result.provider.request({ method: "eth_private_key" }));
  return privateKeyToAccount(with0x(pk));
}

function deriveOwnerFromLocalKey() {
  const pk = env("PRIVATE_KEY", true);
  return privateKeyToAccount(with0x(pk));
}

async function getOwner() {
  return useWeb3Auth()
    ? await deriveOwnerFromWeb3Auth()
    : deriveOwnerFromLocalKey();
}

// --- AA plumbing: smart account + bundler ----------------------------------

function publicClient() {
  return createPublicClient({
    chain: CHAIN,
    transport: http(env("RPC_URL", true)),
  });
}

async function getSmartAccount(owner, client) {
  // Hybrid implementation: owner is an EOA signer (deployParams =
  // [owner, p256KeyIds, p256X, p256Y] — empty arrays = no passkey signers).
  return toMetaMaskSmartAccount({
    client,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: "0x",
    signer: { account: owner },
  });
}

function pimlicoUrl() {
  const key = env("PIMLICO_API_KEY", true);
  return `https://api.pimlico.io/v2/sepolia/rpc?apikey=${key}`;
}

function getPimlicoClient() {
  return createPimlicoClient({
    transport: http(pimlicoUrl()),
    entryPoint: { address: entryPoint07Address, version: "0.7" },
  });
}

function getBundlerClient(client, paymaster) {
  return createBundlerClient({
    client,
    paymaster,
    transport: http(pimlicoUrl()),
  });
}

// --- commands --------------------------------------------------------------

async function cmdLogin() {
  if (!useWeb3Auth())
    die(
      "Web3Auth is not configured. `login` is only needed in Web3Auth mode.\n" +
        "  (You currently use a local PRIVATE_KEY — no login required.)",
    );

  const clientId = env("GOOGLE_CLIENT_ID", true);
  const clientSecret = env("GOOGLE_CLIENT_SECRET", true);

  // PKCE
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = randomBytes(16).toString("hex");

  const googleTokens = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.startsWith("/callback")) {
          res.writeHead(404).end();
          return;
        }
        if (url.searchParams.get("state") !== state)
          throw new Error("state mismatch");
        const code = url.searchParams.get("code");
        if (!code) throw new Error("no authorization code returned");

        const port = server.address().port;
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `http://localhost:${port}/callback`,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }),
        });
        const tokens = await tokenRes.json();
        if (!tokens.id_token)
          throw new Error(
            `token exchange failed: ${JSON.stringify(tokens)}`,
          );

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h2>✓ Login complete.</h2><p>You can close this tab and return to the terminal.</p>",
        );
        server.close();
        resolve(tokens);
      } catch (e) {
        res.writeHead(500).end(String(e));
        server.close();
        reject(e);
      }
    });

    server.listen(0, () => {
      const port = server.address().port;
      const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: `http://localhost:${port}/callback`,
          response_type: "code",
          scope: "openid email profile",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          access_type: "offline",
          prompt: "consent",
        });
      console.log("\nOpening browser for Google login…");
      console.log(`If it doesn't open, visit:\n  ${authUrl}\n`);
      openBrowser(authUrl);
    });
  });

  if (!googleTokens.refresh_token) {
    console.warn(
      "\n⚠ Google did not return a refresh_token. Later commands may need a " +
        "re-login. Revoke access at https://myaccount.google.com/permissions " +
        "and run `login` again to force one.",
    );
  }
  saveSession({
    refreshToken: googleTokens.refresh_token || null,
    idToken: googleTokens.id_token, // single-use fallback
    loggedInAt: new Date().toISOString(),
  });

  // Confirm by deriving the smart account address.
  const owner = await deriveOwnerFromWeb3Auth();
  const client = publicClient();
  const sa = await getSmartAccount(owner, client);
  console.log(`\n✓ Logged in. Smart Account address:\n  ${sa.address}\n`);
}

function cmdLogout() {
  if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE);
  console.log("✓ Session cleared.");
}

async function cmdAddress() {
  const owner = await getOwner();
  const client = publicClient();
  const sa = await getSmartAccount(owner, client);
  const deployed = (await client.getCode({ address: sa.address })) !== undefined;
  console.log(`Owner (signer): ${owner.address}`);
  console.log(`Smart Account : ${sa.address}`);
  console.log(`Deployed      : ${deployed ? "yes" : "no (counterfactual — deploys on first send)"}`);
}

async function cmdBalance() {
  const owner = await getOwner();
  const client = publicClient();
  const sa = await getSmartAccount(owner, client);
  const wei = await client.getBalance({ address: sa.address });
  console.log(`Smart Account : ${sa.address}`);
  console.log(`Balance       : ${formatEther(wei)} ETH (Sepolia)`);
}

async function cmdSend(args) {
  const to = args[0];
  const amount = args[1];
  const confirmed = args.includes("--confirm");

  if (!to || !amount)
    die("Usage: node wallet.js send <to-address> <amount-eth> --confirm");
  if (!isAddress(to)) die(`Invalid recipient address: ${to}`);

  const owner = await getOwner();
  const client = publicClient();
  const sa = await getSmartAccount(owner, client);

  // Human-readable summary BEFORE signing (no blind signing).
  console.log("\n──────────── Transaction to approve ────────────");
  console.log(`  From (Smart Account): ${sa.address}`);
  console.log(`  To                  : ${to}`);
  console.log(`  Amount              : ${amount} ETH`);
  console.log(`  Gas                 : sponsored by Pimlico paymaster (gasless)`);
  console.log(`  Network             : Sepolia`);
  console.log("─────────────────────────────────────────────────");

  if (!confirmed) {
    console.log(
      "\nNot sent. Re-run with --confirm to authorize this transaction.\n",
    );
    return;
  }

  const pimlico = getPimlicoClient();
  const bundler = getBundlerClient(client, pimlico);
  const { fast } = await pimlico.getUserOperationGasPrice();

  console.log("\nSubmitting UserOperation…");
  const userOpHash = await bundler.sendUserOperation({
    account: sa,
    calls: [{ to, value: parseEther(amount) }],
    maxFeePerGas: fast.maxFeePerGas,
    maxPriorityFeePerGas: fast.maxPriorityFeePerGas,
  });
  console.log(`  UserOpHash: ${userOpHash}`);
  console.log("  Waiting for inclusion…");

  const receipt = await bundler.waitForUserOperationReceipt({
    hash: userOpHash,
  });
  const txHash = receipt.receipt.transactionHash;
  console.log(`\n✓ ${receipt.success ? "Success" : "Reverted"}`);
  console.log(`  Tx hash : ${txHash}`);
  console.log(`  Explorer: https://sepolia.etherscan.io/tx/${txHash}\n`);
}

async function cmdTx(args) {
  const hash = args[0];
  if (!hash) die("Usage: node wallet.js tx <userOpHash | txHash>");

  const client = publicClient();

  // Try as a UserOperation hash first.
  try {
    const bundler = getBundlerClient(client, getPimlicoClient());
    const receipt = await bundler.getUserOperationReceipt({ hash });
    if (receipt) {
      const txHash = receipt.receipt.transactionHash;
      console.log(`UserOperation ${receipt.success ? "succeeded" : "reverted"}`);
      console.log(`  Tx hash : ${txHash}`);
      console.log(`  Explorer: https://sepolia.etherscan.io/tx/${txHash}`);
      return;
    }
  } catch {
    /* fall through to plain tx lookup */
  }

  // Fall back to a normal transaction hash.
  try {
    const r = await client.getTransactionReceipt({ hash });
    console.log(`Transaction status: ${r.status}`);
    console.log(`  Block   : ${r.blockNumber}`);
    console.log(`  Explorer: https://sepolia.etherscan.io/tx/${hash}`);
  } catch {
    console.log("Not found yet (still pending?) — try again shortly.");
  }
}

function cmdHelp() {
  console.log(`
cli-aa-wallet-skill — Account Abstraction wallet on Sepolia

  node wallet.js login                     Google login (Web3Auth mode only)
  node wallet.js logout                    Clear the saved session
  node wallet.js address                   Show owner + smart account address
  node wallet.js balance                   Show smart account ETH balance
  node wallet.js send <to> <eth> --confirm Send ETH (gasless). Omit --confirm to preview.
  node wallet.js tx <userOpHash|txHash>    Check a transaction / user operation

Signer mode is chosen automatically:
  • WEB3AUTH_CLIENT_ID set  -> Web3Auth + Google login (run \`login\` first)
  • otherwise               -> local PRIVATE_KEY (quick testing)

See README.md for setup.
`);
}

// --- entrypoint ------------------------------------------------------------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "login":
        return await cmdLogin();
      case "logout":
        return cmdLogout();
      case "address":
        return await cmdAddress();
      case "balance":
        return await cmdBalance();
      case "send":
        return await cmdSend(args);
      case "tx":
        return await cmdTx(args);
      case "help":
      case undefined:
        return cmdHelp();
      default:
        die(`Unknown command: ${cmd}. Run \`node wallet.js help\`.`);
    }
  } catch (e) {
    die(e?.shortMessage || e?.message || String(e));
  }
}

main();
