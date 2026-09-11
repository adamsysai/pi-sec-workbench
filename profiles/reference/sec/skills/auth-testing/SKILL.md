---
description: "Authentication and session testing — OAuth, JWT, session management, MFA bypass"
---
# Authentication & Authorization Testing

## When to Use
When testing authentication mechanisms, session management, and access control.

## Procedure

### Authentication
1. **Brute force**: Test for missing rate limiting on login
2. **Credential stuffing**: Check if login differentiates between "user not found" and "wrong password"
3. **Password policy**: Test weak passwords, common passwords
4. **Password reset**: Test reset token predictability, expiry, email enumeration
5. **MFA**: Test MFA bypass, race conditions, token reuse
6. **OAuth**: Test redirect URI validation, state parameter, token theft
7. **SAML**: Test XML signature wrapping, certificate validation

### Session Management
1. **Session tokens**: Check randomness, length, predictability
2. **Session fixation**: Test if session ID changes after login
3. **Session timeout**: Test idle/absolute timeout enforcement
4. **Cookie security**: HttpOnly, Secure, SameSite flags
5. **Session storage**: Check if sessions are stored securely server-side

### Access Control
1. **Vertical**: Can a regular user access admin functions?
2. **Horizontal (IDOR/BOLA)**: Can user A access user B's resources?
3. **Context-dependent**: Force browsing to pages without authentication
4. **API**: Manipulate object IDs in API calls
5. **Multi-step**: Skip steps in multi-step workflows

## Verification
- Every access control test has a clear before/after state
- PoC demonstrates unauthorized access or action
- Privilege escalation chain documented if applicable
