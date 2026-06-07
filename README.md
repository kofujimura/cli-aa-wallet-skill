# cli-aa-wallet-skill

A minimal CLI **smart-account wallet** for EVM chains, driven by natural
language from Codex or Claude Code. It is the Account Abstraction (ERC-4337)
successor to [`cli-wallet-skill`](https://github.com/kofujimura/cli-wallet-skill):

| | `cli-wallet-skill` (EOA) | `cli-aa-wallet-skill` (AA) |
|---|---|---|
| Account | EOA | **MetaMask Smart Account** (ERC-4337) |
| Key | plaintext private key in `.env.local` | **Google login → Web3Auth** (key reconstructed in memory) |
| Gas | paid by the EOA | **sponsored by a paymaster (gasless)** |
| `send` | signs a tx | submits a **UserOperation** |

Network: **Sepolia** testnet.

## Architecture

```
Google login (loopback OAuth)              ── login saves a refresh_token
        │  fresh id_token minted per command (silent refresh; never reused)
        ▼
Web3Auth Node SDK  ── reconstructs a secp256k1 key in memory (non-custodial)
        │  owner signer (viem account)
        ▼
MetaMask Smart Account (Hybrid)  ── @metamask/delegation-toolkit
        │  UserOperation
        ▼
Pimlico bundler + paymaster  ── gasless send on Sepolia
```

The signer layer and the smart-account layer are independent. You can swap the
signer for a local `PRIVATE_KEY` to test the AA stack without any login setup.

Web3Auth rejects a reused JWT (`Duplicate token found`), so `login` stores the
Google **refresh_token** and every later command silently mints a *fresh*
id_token from it — no per-command browser popup, and no private key on disk.

## Quick start (local key — no login setup)

The fastest way to see a gasless smart-account transaction on Sepolia:

1. `cp .env.example .env.local`
2. In `.env.local`, set:
   - `PIMLICO_API_KEY` — free from <https://dashboard.pimlico.io>
   - `PRIVATE_KEY` — a throwaway key: `openssl rand -hex 32` (prefix `0x`)
   - optionally `RPC_URL` — your Alchemy Sepolia URL
   - leave `WEB3AUTH_CLIENT_ID` **empty** (this selects local-key mode)
3. Install + run:
   ```bash
   npm install
   node wallet.js address          # shows the counterfactual smart-account address
   node wallet.js send 0xRecipient... 0.001   # preview only
   node wallet.js send 0xRecipient... 0.001 --confirm   # actually send (gasless)
   node wallet.js tx <userOpHash>
   ```

The smart account holds no ETH and is undeployed until the first `send`; the
paymaster sponsors gas, and the account deploys itself on that first send.

## Full setup (Google login via Web3Auth)

This is the real goal: log in with Google, no key on disk.

1. **Pimlico**: get `PIMLICO_API_KEY` as above.
2. **Web3Auth** (<https://dashboard.web3auth.io>):
   - Create a project, network = **Sapphire Devnet** (free, allows localhost).
   - Copy the **Client ID** → `WEB3AUTH_CLIENT_ID`.
   - Set `WEB3AUTH_NETWORK` to match the project's network (default
     `sapphire_devnet`). A mismatch causes `verifier ... not found`.
   - Add a **custom auth connection** that validates Google `id_token`s:
     - JWKS endpoint `https://www.googleapis.com/oauth2/v3/certs`
     - JWT user identifier `sub`
     - Validations: `iss` = `https://accounts.google.com`, and
       `aud` = your **Google client ID** (keep `aud` equal to `GOOGLE_CLIENT_ID`;
       if you swap Google clients, update `aud` too or tokens are rejected).
     - Copy its **Auth Connection ID** → `WEB3AUTH_AUTH_CONNECTION_ID`.
3. **Google** (<https://console.cloud.google.com/apis/credentials>):
   - Create an OAuth client of type **Desktop app** (loopback redirect on a
     random port works automatically; no redirect-URI config needed).
   - Copy `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Run:
   ```bash
   npm install
   node wallet.js login        # opens browser, completes Google login
   node wallet.js address
   node wallet.js balance
   node wallet.js send 0xRecipient... 0.001 --confirm
   ```

If `login` warns that Google returned no refresh_token, revoke the app at
<https://myaccount.google.com/permissions> and run `login` again.

## Commands

```
login                      Google login (Web3Auth mode only)
logout                     Clear the saved session
address                    Owner (signer) + smart-account address
balance                    Smart-account ETH balance
send <to> <eth> [--confirm]  Preview, then (with --confirm) send gaslessly
tx <userOpHash|txHash>     Check a user operation or transaction
```

`send` never broadcasts without `--confirm` — it prints a human-readable
preview first. This is the human-in-the-loop signing gate.

## Where to add agent guardrails (session keys / spending limits)

Because the account is a MetaMask Smart Account, you can later delegate a
**scoped session key** to an AI agent with on-chain caveats — e.g. spending
limit, allowed targets/methods, expiry, periodic rate limit — via
`@metamask/delegation-toolkit`. Those limits are enforced on-chain by the
EntryPoint, so they hold even if the agent is compromised. See the MetaMask
Smart Accounts Kit docs.

## Status / caveats

- **Verified end-to-end on Sepolia (2026-06-07).** Full Google path:
  `login` → Web3Auth key derivation → MetaMask Smart Account deploy → gasless
  `send` (UserOperation, paymaster-sponsored) → on-chain success. Example tx:
  <https://sepolia.etherscan.io/tx/0x9f38bd297d5c689af7dd6e3a8534e642644259415d5837230a32f9ce1d2a4909>.
  The local-key fallback path is verified too.
- API signatures were validated against the *installed* package types:
  `@metamask/delegation-toolkit@0.13.0` (`toMetaMaskSmartAccount({ ..., signer:
  { account } })`), viem `createBundlerClient`, and `@web3auth/node-sdk@5`
  (`connect()` returns `{ provider, signer }`).
- `@metamask/delegation-toolkit` has been **renamed to
  `@metamask/smart-accounts-kit`**; 0.13.0 is the last release under the old
  name and is what this project pins. Exports are the same; migrate when
  convenient.
- The Web3Auth SDK revises its API often. If a future `npm install` resolves a
  different major, check <https://docs.metamask.io/embedded-wallets/sdk/node/>
  and adjust `deriveOwnerFromWeb3Auth()` in `wallet.js`.
- Web3Auth Smart Accounts as a *bundled* feature requires the Growth plan in
  production; this project instead wires the bundler/paymaster directly
  (Pimlico) so it runs free on Sepolia.
- Testnet only. Use throwaway keys.
