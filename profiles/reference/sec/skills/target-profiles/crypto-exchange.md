# Target Profile: Cryptocurrency Exchange

> Built from audits of crypto exchanges with REST APIs, API key authentication, and on-chain withdrawals.
> Common stack: REST API with HMAC-signed endpoints + API key/secret auth + Python SDK on GitHub.

## Attack Surface

| Component | What to Look For |
|-----------|-----------------|
| **API** | REST with HMAC SHA256 signing, read endpoints (balances, deposits, trades), write endpoints (orders) |
| **Auth** | API key + secret pair, HMAC-signed POST endpoints |
| **SDK** | Python SDK published on GitHub (endpoint discovery + potential key leaks) |
| **On-chain** | Withdrawal endpoints, deposit address exposure |

## Top Findings

### 1. 🔴 API Keys Leaked in GitHub (CRITICAL)
- API key + secret found in public Python SDK source code
- Key has active cryptocurrency balances
- Write permissions enabled (can place/cancel orders)

### 2. 🟠 API Key Permission Over-Privilege (HIGH)
- Keys have write permissions (place/cancel orders)
- Cannot withdraw directly (no API withdrawal endpoint)
- But can manipulate markets: place sell orders below market price, cancel legitimate orders

### 3. 🟡 Deposit Address Exposure (MEDIUM)
- API exposes deposit addresses
- Enables correlation of on-chain activity to exchange accounts
- Privacy concern for users

## Test Matrix

- [ ] Search GitHub for exchange name + "api", "sdk", "python", "key"
- [ ] Scan SDK source code for hardcoded credentials
- [ ] Test leaked keys: check balances, permissions, deposit addresses
- [ ] Map all API methods from SDK source → probe each endpoint
- [ ] Test write operations: place/cancel orders (use test orders)
- [ ] Brute-force withdrawal endpoint names (coinWithdraw, withdrawCoin, etc.)
- [ ] Check for HMAC signature replay vulnerabilities
- [ ] Test API key scoping: can read-only key access write endpoints?
- [ ] Check for on-chain withdrawal API (highest impact if found)

## Exploit Chain: GitHub SDK → Key Leak → Market Manipulation
```
1. Find exchange Python SDK on GitHub
2. Grep for API key/secret patterns
3. Validate key is live (check balance endpoint)
4. Map permissions (read/write/withdraw)
5. If write: place sell orders below market price
6. If withdraw endpoint exists: attempt withdrawal
7. Even without withdrawal: market manipulation (spoofing, front-running)
```

## What's Usually Clean
- On-chain withdrawals via API (usually don't exist — require web UI + 2FA)
- Price-deviation protection blocks obviously manipulative orders
- HMAC signing is usually properly implemented
