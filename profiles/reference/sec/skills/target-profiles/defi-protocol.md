# Target Profile: DeFi Protocol

> Built from 291+ hack analyses ($31B+ in losses, 2016-2026) and 10+ smart contract audits.
> Covers EVM, Solana, TON, Sui, Flow, Aptos, and Hedera ecosystems.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **Smart Contracts** | Diamond (EIP-2535) proxies, ERC-4626 vaults, AMMs, bridges, oracles |
| **Frontend** | Next.js with WebSocket live feeds, EIP-191 signature verification |
| **Backend** | MongoDB (NoSQL), REST API, WebSocket API |
| **On-chain** | EVM bytecode, storage layout, access control, upgradeability |
| **Off-chain** | Keepers, VRF, oracle signers, governance mechanisms |

## Top Vulnerability Classes (By Loss)

| Rank | Class | % of Hacks | Cumulative Losses | Trend |
|------|-------|-----------|-------------------|-------|
| 1 | Private Key / Social Engineering | ~44% | $3B+ | 🔴 Rising (state actors) |
| 2 | Bridge Exploits | ~15% | $2B+ | Stable (target #1 for single-incident) |
| 3 | Flash Loan Attacks | ~20% | $1B+ | Declining |
| 4 | Oracle Manipulation | ~10% | $500M+ | Declining (Chainlink adoption) |
| 5 | Logic Errors | ~15% | $500M+ | Stable |
| 6 | Reentrancy | ~8% | $300M+ | Declining (Solidity 0.8) |
| 7 | Integer Overflow | ~5% | $250M+ | Rare in EVM post-0.8 |
| 8 | Governance Attacks | ~3% | $200M+ | Low frequency, high impact |

### Key Trend
**Off-chain attacks dominate**: 56.5% of 2024+ attacks are off-chain (social engineering, supply chain, key theft), representing 80.5% of losses. The smart contract layer is becoming better audited; the human/infrastructure layer is the new frontier.

## Critical Patterns to Test

### 1. 🔴 Oracle Manipulation
- **Off-chain oracle signers compromised**: Attacker submits fraudulent prices with valid signatures
- System validates WHO signed, not WHAT was signed (no plausibility bounds)
- BLS signature edge case: zero-valued identity (point at infinity) satisfies pairing for any message
- **Test**: Can you submit a price 12 orders of magnitude above market? Are there deviation checks?

### 2. 🔴 ERC-4626 Donation Inflation
- `totalAssets()` reads raw `balanceOf` from downstream strategy contracts
- Donate tokens to strategy → inflate parent vault share price → flash redeem
- **Test**: Does `totalAssets()` use `balanceOf(this)` on external contracts? Are there virtual shares/decimals offset?

### 3. 🔴 Bridge DVN Compromise
- `requiredDVNCount = 1` = single point of failure
- RPC poisoning: malicious binaries serve forged data to DVN IPs
- **Test**: How many DVNs required? Are RPC nodes shared/enumerable?

### 4. 🔴 Reentrancy via NFT Callbacks
- `safeTransferFrom` triggers `onERC721Received` callback
- Checks-Effects-Interactions violation: transfer before balance update
- **Test**: Any function receiving NFTs that updates state after transfer?

### 5. 🔴 Flashloan Supply Manipulation
- Flash-deposit + flash-withdraw drives totalSupply to near-zero
- At micro-supply: extreme rounding errors → overvalued shares
- **Test**: What happens at `totalSupply ≈ 0`? Are deprecated vaults drained?

### 6. 🟠 Router/Quoter Math Divergence
- Quoter uses Solidly stable curve; router uses constant-product
- Router computes less output → surplus donated to LPs or swap reverts
- **Test**: Compare quoter output vs actual router output for same trade

### 7. 🟠 Keeper Selective Reveal (Zero Bond)
- Keeper computes outcome before committing; if unfavorable → withhold (free refund)
- **Test**: Is there a bond? What's the penalty for withholding? Is `blockhash(seedBlock)` public?

### 8. 🟠 Stablecoin Burn/Redeem Arbitrage
- `burn()` uses hardcoded $1 valuation instead of market/oracle price
- During depeg: buy below $1, burn for $1 collateral
- **Test**: Does burn use hardcoded peg? Is it flashloan-accessible?

## DeFi Protocol Assessment Framework

| Check | What to Look For | Risk Level |
|-------|-----------------|------------|
| Oracle type | Spot DEX price (HIGH) vs Chainlink/TWAP (LOW) | Critical |
| ERC-4626 implementation | OZ v4.9+ virtual shares? Or raw balanceOf? | Critical |
| Reentrancy guards | nonReentrant on all state-changing? NFT callbacks? | High |
| Flashloan exposure | Can state be manipulated atomically in one tx? | High |
| Deprecated vaults | Are old contracts drained? Residual balances? | High |
| LP collateral pricing | get_dy() or virtual_price as oracle? | High |
| Deviation timelocks | Short TWAP + deviation thresholds = griefing | Medium |
| Admin controls | Can owner mint unlimited? Is ownership renounced? | Critical |
| Bridge DVN count | requiredDVNCount = 1? Multiple independent DVNs? | Critical |
| Timelock on config | Can admin change critical params instantly? | High |
| Prior exploit history | Did protocol pivot after hack? Same architecture? | Medium |

## Non-EVM Patterns

### TON (FunC)
- LP token minting via notification callback: `notification_receiver` is attacker-controlled
- Arbitrary vault messages: `notification_data` extracted before `verify_proof`
- Missing reentrancy guards in `recv_internal`
- `SEND_MODE_CARRY_ALL_BALANCE` enables gas theft

### Sui (Move)
- Dead code overflow: `shlw` (left shift without overflow check)
- Silent truncation: `mul_shl` casts u128 to u64 without bounds check
- Precision loss: u256 → u64 truncation in `div_round` result
- Asymmetric safety: `get_amount_x_delta` uses `checked_shlw` but `get_amount_y_delta` doesn't

### Flow (Cadence)
- Type confusion: Resources (move semantics) disguised as copyable structures → token duplication
- Capability misuse, reference borrowing attacks, resource attachment bugs

### Hedera
- BLS oracle bypass: zero-signature (point at infinity) accepted as valid → forged price feeds

## Test Matrix

### Phase 1: On-Chain Recon
- [ ] Verify contract source on block explorer
- [ ] If unverified: decompile bytecode (heimdall-rs, Foundry cast)
- [ ] Enumerate Diamond facets via DiamondLoupe
- [ ] Map all function selectors → resolve via 4byte directory
- [ ] Recover storage layout at `keccak256("diamond.standard.diamond.storage")`
- [ ] Check if contracts are upgradeable (proxy pattern)
- [ ] Check timelock on admin functions

### Phase 2: Access Control
- [ ] Can owner mint unlimited tokens?
- [ ] Is ownership renounced or multisig?
- [ ] Can admin change critical config instantly (no timelock)?
- [ ] Is there a single EOA controlling all upgrades?
- [ ] Check all `onlyOwner` / `onlyRole` modifiers

### Phase 3: Economic Attacks
- [ ] Test oracle manipulation (low-liquidity pairs)
- [ ] Test flashloan attacks (deposit → manipulate → withdraw in one tx)
- [ ] Test donation inflation on ERC-4626 vaults
- [ ] Test at totalSupply ≈ 0 (rounding exploitation)
- [ ] Test router/quoter divergence
- [ ] Test keeper selective-reveal (zero bond)
- [ ] Test stablecoin burn arbitrage during depeg

### Phase 4: Reentrancy
- [ ] Check all functions with external calls
- [ ] Test NFT/SFT callback paths (onERC721Received)
- [ ] Check for nonReentrant on all state-changing functions
- [ ] Test cross-contract reentrancy

### Phase 5: Off-Chain
- [ ] WebSocket endpoints often skip auth (test separately from REST)
- [ ] Frontend signature verification ≠ backend enforcement
- [ ] Admin signatures in URLs (logged, cached, referred)
- [ ] NoSQL injection via negative parameters (page=-1)
- [ ] Empty-string search returns ALL records with internal IDs

## Tools
- **Foundry** (`cast`, `forge`) — on-chain calls, local fork testing
- **heimdall-rs** — bytecode decompilation (lossy, verify at opcode level)
- **EVM disassembler** — custom opcode analysis
- **4byte directory** — function selector resolution
- **Block explorer** — source code verification
- **WebSocket client** — test WS auth separately
- **DeFiLlama** — protocol context, TVL, hack history
