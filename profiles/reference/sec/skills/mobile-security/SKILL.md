---
description: "Mobile app security — APK/IPA reverse engineering, API interception, certificate pinning bypass"
---
# Mobile Application Security

## When to Use
When testing iOS or Android applications for security vulnerabilities.

## Procedure
1. **Static analysis**: Decompile APK (jadx), inspect IPA, check for hardcoded secrets
2. **Network**: Intercept traffic (mitmproxy/Burp), test certificate pinning
3. **Storage**: Check localStorage, Keychain/Keystore, SharedPreferences
4. **Deep links**: Test custom URL schemes, intent hijacking, WebView exposure
5. **Client-side**: Test for insecure crypto, debug flags, root/jailbreak detection
6. **API**: Test backend API used by app — same as API security testing
7. **Auth**: Test token storage, refresh token rotation, biometric auth bypass

## Key Tools
- jadx — Android decompiler
- frida — runtime instrumentation
- mitmproxy — traffic interception
- objection — mobile security framework

## Verification
- Findings confirmed with decompiled code evidence or runtime PoC
- Backend API vulnerabilities documented separately
