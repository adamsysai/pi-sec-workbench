# DeFi Audit Checklist

> Systematic assessment framework for smart contract protocols.

## Pre-Audit

- [ ] Identify blockchain (EVM, Solana, TON, Sui, Flow, Aptos, Hedera)
- [ ] Check if contract source is verified on block explorer
- [ ] If unverified: decompile bytecode (heimdall-rs, Foundry cast)
- [ ] Identify contract pattern (Diamond, proxy, ERC-4626, AMM, etc.)
- [ ] Check for prior exploit history (did protocol pivot after hack?)

## Access Control

- [ ] Can owner mint unlimited tokens?
- [ ] Is ownership renounced or multisig?
- [ ] Can admin change critical config instantly (no timelock)?
- [ ] Is there a single EOA controlling all upgrades?
- [ ] Are `delegatecall` targets settable by admin?
- [ ] Are all admin functions protected by `onlyOwner` / `onlyRole`?
- [ ] Is there a timelock on admin actions?

## Oracle

- [ ] What oracle type? (Spot DEX = HIGH, Chainlink/TWAP = LOW)
- [ ] Are there min/max deviation bounds?
- [ ] Is there a single oracle source with no fallback?
- [ ] Can a price 12+ orders of magnitude above market be submitted?
- [ ] Are oracle signer keys in a multisig?

## ERC-4626 Vaults

- [ ] Does `totalAssets()` use `balanceOf(this)` on external contracts?
- [ ] Are there virtual shares/decimals offset (OZ v4.9+)?
- [ ] Can someone donate to a strategy module?
- [ ] Are deprecated vaults drained?
- [ ] What happens at `totalSupply ≈ 0`?

## Reentrancy

- [ ] Is `nonReentrant` on ALL state-changing functions?
- [ ] Are external calls made before state updates (CEI violation)?
- [ ] Any function receiving NFTs that updates state after transfer?
- [ ] Are `onERC721Received` / `onERC1155Received` handled safely?
- [ ] Are there cross-contract reentrancy paths?

## Flash Loan Exposure

- [ ] Can state be manipulated atomically in one transaction?
- [ ] Are there flash loan guards?
- [ ] Is there a reentrancy lock during flash loan execution?
- [ ] Can flash loans be used for: oracle manipulation, governance, supply manipulation?

## Bridge Security

- [ ] How many DVNs required? (`requiredDVNCount = 1` = CRITICAL)
- [ ] Are RPC nodes enumerable or shared?
- [ ] Is there independent source-chain verification?
- [ ] Are validator keys in a multisig?
- [ ] Is signature verification properly implemented?

## AMM / DEX

- [ ] Do router and quoter use the same math? (divergence = MEV)
- [ ] Are there precision losses in tick math?
- [ ] Can `get_dy()` or `virtual_price` be used as oracle? (manipulable)
- [ ] Are there sandwich attack vectors?
- [ ] Are LP tokens properly priced?

## Economic / Game Theory

- [ ] Is there a keeper bond? (zero bond = selective-reveal attack)
- [ ] Is randomness derived from public data?
- [ ] Can keeper compute outcome before committing?
- [ ] Are there inflation attack vectors on vaults?
- [ ] Can reward distribution be gamed via lagging supply index?

## Stablecoin Specific

- [ ] Does `burn()` use hardcoded $1 valuation? (depeg arbitrage)
- [ ] Is burn flashloan-accessible?
- [ ] Are there circuit breakers during depeg?
- [ ] Is collateral ratio properly maintained?

## Non-EVM Specific

### TON (FunC)
- [ ] Are reentrancy guards in `recv_internal`?
- [ ] Is `notification_receiver` attacker-controlled?
- [ ] Is `notification_data` extracted before verification?
- [ ] Does `SEND_MODE_CARRY_ALL_BALANCE` enable gas theft?

### Sui (Move)
- [ ] Are there `shlw` (left shift without overflow check) usages?
- [ ] Are there u128→u64 truncations without bounds check?
- [ ] Is `checked_shlw` used consistently (not just in one function)?
- [ ] Are there precision losses in `div_round`?

### Flow (Cadence)
- [ ] Are resources properly non-copyable?
- [ ] Are there type confusion vulnerabilities?
- [ ] Are capabilities properly scoped?
- [ ] Are reference borrowing attacks possible?

### Hedera
- [ ] Does BLS oracle reject zero-signature (point at infinity)?
- [ ] Are there plausibility bounds on oracle prices?

## Tools

- **Foundry** (`cast`, `forge`) — on-chain calls, local fork, fuzzing
- **heimdall-rs** — bytecode decompilation (lossy, verify at opcode level)
- **4byte directory** — function selector resolution
- **Block explorer** — source code verification
- **DeFiLlama** — protocol context, TVL, hack history
- **EVM disassembler** — custom opcode analysis for unverified contracts
