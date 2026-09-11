---
description: "Software testing — unit, integration, e2e, mocking, coverage, TDD"
---
# Testing

## When to Use

- Writing or reviewing tests for any codebase
- Setting up a testing framework (Vitest, Jest, Playwright)
- Establishing TDD workflow or coverage targets
- Debugging flaky tests or improving test reliability

## Procedure

1. **Follow the test pyramid** — many unit tests, fewer integration tests, very few E2E tests.

2. **Choose the right framework:**
   - **Vitest** for Vite/ESM projects (fast, compatible API with Jest)
   - **Jest** for legacy CJS/React projects
   - **Playwright** for E2E (cross-browser, auto-wait, trace viewer)
   - **testing-library** for React component tests (query by role, not by class)

3. **Use the TDD cycle (red-green-refactor):**
   ```
   1. Write a failing test
   2. Write the minimum code to pass
   3. Refactor while keeping tests green
   ```

4. **Structure tests with AAA pattern:**
   ```ts
   test('creates user with valid email', async () => {
     // Arrange
     const input = { email: 'test@example.com', name: 'Test' };
     // Act
     const user = await createUser(input);
     // Assert
     expect(user.id).toBeDefined();
     expect(user.email).toBe(input.email);
   });
   ```

5. **Mock APIs with MSW (Mock Service Worker)** — intercepts network at the service worker level, works in both Node and browser:
   ```ts
   import { http, HttpResponse } from 'msw';
   export const handlers = [
     http.get('/api/users', () => HttpResponse.json([{ id: 1 }])),
   ];
   ```

6. **Ensure test isolation** — no shared state between tests. Reset mocks and state in `beforeEach`.

7. **Target 80%+ branch coverage** — focus on branch over line coverage, and exclude config/generated files:
   ```json
   { "coverage": { "thresholds": { "branches": 80, "lines": 80 } } }
   ```

8. **Use property-based testing** with fast-check for algorithms and parsers:
   ```ts
   import { fc, test as fcTest } from '@fast-check/vitest';
   fcTest.prop([fc.string()])('parse(format(s)) === s', (s) => {
     expect(parse(format(s))).toBe(s);
   });
   ```

9. **Write integration tests with testcontainers** — spin up real Postgres/Redis in Docker for the test run:
   ```ts
   const pg = await new PostgreSqlContainer().start();
   ```

10. **Detect and quarantine flaky tests** — mark with `.flake` or move to a quarantined suite. Use Playwright's retry and trace viewer for E2E flakiness.

## Pitfalls

- Snapshot testing overuse — snapshots break on trivial changes and don't assert behavior
- Testing implementation details (internal functions) instead of public API
- Shared state between tests causes order-dependent failures
- E2E tests without proper isolation — one test's data pollutes the next
- Ignoring flaky tests — they erode trust in the suite

## Verification

- `npm test` (or `vitest run`) passes in CI with zero failures
- Coverage report shows ≥ 80% branch coverage on core modules
- Tests run in any order with the same result (no order dependency)
- `npx playwright test --reporter=line` passes consistently across 3 runs
- No `skip` or `todo` tests accumulating without a tracking issue
