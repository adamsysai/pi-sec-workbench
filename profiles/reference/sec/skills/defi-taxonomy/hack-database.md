# DeFi Hack Database (2016-2026)

> 291+ hacks catalogued, $31B+ in cumulative losses. Built from real incident analysis.

## Hack Evolution Timeline

| Period | Dominant Vector | Notable Incidents | Total Loss |
|--------|----------------|-------------------|------------|
| 2016-2017 | Reentrancy, Integer Overflow | The DAO ($70M), Parity Multisig ($150M) | ~$500M |
| 2018-2019 | Access Control, Logic Errors | Multiple smaller incidents | ~$1.5B |
| 2020-2021 | Flash Loans, Oracle Manipulation | Cream Finance, Compound, Poly Network ($611M) | ~$5B |
| 2022 | Bridge Exploits, Social Engineering | Ronin ($586M), Wormhole ($326M), Nomad ($190M) | ~$4B |
| 2023 | Reentrancy (Vyper bug), Bridge | Curve Finance ($70M), Euler ($197M) | ~$2B |
| 2024 | Supply Chain, Key Compromise | Radiant Capital, WazirX, Bybit prep | ~$3B |
| 2025-2026 | Supply Chain + Social Eng | Bybit ($1.5B), Kelp DAO, Cetus ($230M) | ~$15B+ |

## Top 15 Hacks by Loss

| Rank | Loss | Vector | Root Cause |
|------|------|--------|------------|
| 1 | $1.5B | Supply Chain Attack | Wallet UI infrastructure compromised, malicious transaction signing |
| 2 | $611M | Bridge Exploit | Validator key compromise, forged signatures |
| 3 | $586M | Bridge Exploit | Validator private keys stolen via social engineering |
| 4 | $326M | Bridge Exploit | Signature verification bypass |
| 5 | $230M | Logic Error | Smart contract decimal precision manipulation |
| 6 | $197M | Flash Loan + Logic Error | Donation inflation + flash loan redemption |
| 7 | $197M | Oracle Manipulation | Low-liquidity oracle manipulation |
| 8 | $190M | Bridge Exploit | Merkle root set to 0x00 (crowd-looting) |
| 9 | $182M | Governance Attack | Flash loan to acquire voting power → malicious proposal |
| 10 | $130M | Flash Loan | Amplified oracle manipulation |
| 11 | $115M | Oracle Manipulation | Price feed manipulation for lending protocol |
| 12 | $92M | Oracle Manipulation | Off-chain oracle signer compromise |
| 13 | $70M | Reentrancy | Vyper compiler bug (0.3.1-0.3.4) |
| 14 | $69M | Reentrancy | Vyper compiler bug (same) |
| 15 | $62.5M | Supply Chain | Rogue developer injected backdoor |

## Key Structural Insights

### 1. Off-Chain Attacks Now Dominate
- **56.5%** of 2024+ attacks are off-chain (social engineering, supply chain, key theft)
- Representing **80.5%** of losses
- Smart contract layer is better audited; human/infrastructure layer is the new frontier

### 2. Bridges Are Highest-Value Target
- Cross-chain infrastructure produces largest single-incident losses
- Hold custody of assets from multiple chains
- Complex validator/signer setups = more attack surface
- Average bridge loss: $300M+

### 3. Single Points of Failure Are Universal
- One EOA controlling all proxy upgrades
- One keeper key with no bond
- One admin who can set floor price to 0
- Centralized control without timelock/multisig = most common critical finding

### 4. Router/Quoter Divergence Is Underappreciated
- When quoting system and execution system use different math
- Core invariant "what you see is what you get" breaks
- Enables MEV extraction and silent losses

### 5. Custom Randomness Is Always Suspect
- Protocols replacing Chainlink VRF with custom keepers invariably introduce selective-reveal attacks
- Keeper computes outcome before committing; if unfavorable → withhold (zero penalty when bond=0)

## Attack Frequency by Category (2016-2026)

```
Private Key / Social Engineering  ████████████████████████████████ 44%
Flash Loan Attacks               ████████████████ 20%
Bridge Exploits                  ███████████ 15%
Logic Errors                     ███████████ 15%
Oracle Manipulation              ███████ 10%
Reentrancy                       █████ 8%
Integer Overflow                 ███ 5%
Governance Attacks               ██ 3%
```

## Loss Distribution by Category

```
Private Key / Social Engineering  ████████████████████████████████████████ $3B+
Bridge Exploits                  ████████████████████████████ $2B+
Flash Loan Attacks               ███████████████ $1B+
Oracle Manipulation              ███████ $500M+
Logic Errors                     ███████ $500M+
Reentrancy                       ████ $300M+
Integer Overflow                 ███ $250M+
Governance Attacks               ███ $200M+
```
