# Non-EVM Smart Contract Patterns

> Vulnerability patterns specific to non-EVM blockchains.

## TON (FunC)

### Reentrancy via Notification Callback
- `notification_receiver` is attacker-controlled
- LP token minting sent before verification
- `notification_data` extracted before `verify_proof`
- Missing reentrancy guards in `recv_internal`

### Gas Theft
- `SEND_MODE_CARRY_ALL_BALANCE` sends entire contract balance
- Attacker triggers mode via crafted message
- Contract drained of gas funds

### Vault Message Injection
- Arbitrary vault messages accepted
- Proof checks sender, not message content
- Attacker can inject messages to internal systems

## Sui (Move)

### Dead Code Overflow
- `shlw` (left shift without overflow check) — public, importable
- Even if dead code, it's importable by other modules

### Silent Truncation
- `mul_shl` casts u128 to u64 without bounds check
- Large values silently truncated
- Precision loss in `get_amount_y_delta`

### Asymmetric Safety
- `get_amount_x_delta` uses `checked_shlw` correctly
- `get_amount_y_delta` does NOT use `checked_shlw`
- One function safe, the other not — easy to miss in audit

### u256 → u64 Truncation
- `div_round` result truncated
- Large intermediate calculations lose precision
- Can be exploited for value extraction

## Flow (Cadence)

### Type Confusion
- Resources (move semantics, non-copyable) disguised as copyable data structures
- Runtime bug allows token duplication
- Resource vs data type confusion

### Capability Misuse
- Capabilities grant access without proper scoping
- Reference borrowing attacks
- Resource attachment bugs
- Interface conformance issues

## Aptos (Move)

### Order Eviction in Matching Engine
- Archived/unmaintained code
- Vulnerability will never be patched
- Check if protocol uses deprecated Aptos framework code

## Hedera

### BLS Oracle Bypass
- Zero-signature (point at infinity) accepted as valid
- Forged price feeds accepted
- Borrow against worthless collateral
- **Test**: Does oracle reject `0x0000000000000000000000000000000000000000000000000000000000000000` as signature?

## Cross-VM Common Patterns

| Pattern | EVM | Solana | TON | Sui | Flow |
|---------|-----|--------|-----|-----|------|
| Reentrancy | ✅ | ✅ | ✅ | ✅ | ✅ |
| Integer overflow | Rare (0.8) | ✅ | ✅ | ✅ | ❓ |
| Access control | ✅ | ✅ | ✅ | ✅ | ✅ |
| Oracle manipulation | ✅ | ✅ | N/A | ✅ | N/A |
| Flash loan | ✅ | ✅ | ❌ | ✅ | ❌ |
| Signature bypass | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bridge exploits | ✅ | ✅ | ✅ | ✅ | N/A |

## Key Insight

Non-EVM chains have MORE vulnerability classes than EVM because:
1. Languages are newer (Move, FunC, Cadence) — less battle-tested
2. Compiler bugs are more common (Vyper 2023 incident)
3. Type systems introduce new attack surfaces (resource vs data confusion)
4. Less tooling available for analysis
5. Fewer auditors with deep expertise

**When auditing non-EVM:** Always check compiler version, language-specific bugs, and type system edge cases. The Solidity-centric audit frameworks (Slither, Mythril) don't apply.
