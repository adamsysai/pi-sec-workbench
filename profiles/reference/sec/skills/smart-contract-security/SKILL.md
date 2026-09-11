---
description: "Smart contract auditing — Solidity, EVM, DeFi attacks, flash loans, reentrancy"
---
# Smart Contract Security (Basic)

## When to Use
When auditing Solidity smart contracts for vulnerabilities.

## Procedure
1. **Read the contract**: Understand purpose, access controls, value flows
2. **Access control**: Check for missing onlyOwner, unprotected functions
3. **Reentrancy**: Check external calls before state changes (checks-effects-interactions)
4. **Integer overflow**: Check for unchecked math (pre-Solidity 0.8)
5. **Oracle manipulation**: Check price feed sources, TWAP usage
6. **Flash loan attacks**: Check if a single transaction can manipulate state
7. **Frontrunning**: Check for MEV-vulnerable patterns
8. **Delegatecall**: Check for storage collisions, arbitrary delegatecall
9. **Self-destruct**: Check for selfdestruct usage
10. **Run tools**: Slither, Mythril for automated analysis

## Key Vulnerability Classes
- Reentrancy (CWE-1078)
- Access control (CWE-862)
- Integer overflow (CWE-190)
- Unchecked return values (CWE-252)
- tx.origin authentication (CWE-477)
- Delegatecall to untrusted callee

## Verification
- Vulnerability confirmed with Foundry test or manual analysis
- Gas implications noted
- Exploit scenario described step-by-step
