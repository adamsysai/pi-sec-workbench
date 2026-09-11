---
description: "Code review methodology — correctness, security, maintainability, standards"
---
# Code Review

## When to Use

- Reviewing a pull request or code diff
- Conducting a security or performance focused review
- Providing feedback on a teammate's code
- Establishing review standards for a team

## Procedure

1. **Run the review checklist first:**
   - Does the code do what the PR description claims?
   - Are edge cases handled (null, empty, boundary values)?
   - Is error handling present and correct?
   - Are tests added or updated for the change?
   - Is naming clear and consistent with the codebase?
   - Is there dead code, commented-out code, or leftover debug logs?

2. **Security review** — check for:
   - Input validation on all external input (API params, user content, file uploads)
   - Authorization checks — can this user access/modify this resource?
   - SQL injection — parameterized queries, not string concatenation
   - XSS — output encoding, not raw insertion of user content into HTML
   - Secrets in code — API keys, passwords, tokens committed to the repo
   - Dependency vulnerabilities — `npm audit` / `pip-audit` / `govulncheck`

3. **Performance review** — look for:
   - N+1 queries — batch fetch or join instead of looping queries
   - Unnecessary allocations in hot paths (large array copies, string concatenation)
   - Blocking calls inside async functions
   - Missing database indexes on new query patterns
   - Large API payloads — paginate or select only needed fields

4. **Review etiquette:**
   - Review the code, not the person — "this function could be simplified" not "you wrote this wrong"
   - Suggest, don't dictate — "consider extracting this to a helper" not "extract this"
   - Praise good patterns — call out clean code, clever solutions, good test coverage
   - Ask questions to understand intent before flagging an issue
   - Don't block on style — use a linter/formatter for that

5. **Comment with severity prefixes:**
   - `blocker:` — must fix before merge (security, data loss, broken functionality)
   - `suggestion:` — recommended improvement, not blocking
   - `nit:` — minor style or preference, optional
   - `question:` — seeking clarification, not requesting a change

6. **Keep PRs under 400 lines** when possible — split large changes into smaller, reviewable PRs.

7. **Verify CI passes** before approving. Don't merge with red CI.

8. **Self-review your own PR** before requesting review — read every diff line.

## Pitfalls

- Rubber-stamping — approving without reading the diff
- Bikeshedding — spending 20 minutes on naming while missing a security issue
- Approving your own PR without review — breaks the quality gate
- Comment overload — 50 comments on a small PR overwhelms the author
- Not following up on requested changes — author marks "resolved" without addressing

## Verification

- Every PR has at least one reviewer approval before merge
- CI is green at the time of merge
- No `blocker:` comments remain unresolved
- Security-sensitive changes (auth, crypto, payments) have an additional domain expert review
- Review feedback is actionable and specific — not "fix this" but "this should use a parameterized query to prevent SQL injection, see example in src/db/users.ts"
