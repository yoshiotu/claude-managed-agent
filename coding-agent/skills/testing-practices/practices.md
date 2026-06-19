# Testing Practices for blueberry

## Test levels
1. **Unit tests** — required for all business logic and utility functions.
2. **Integration tests** — required for API endpoints and database interactions.
3. **E2E tests** — optional; add when the feature has a critical user journey.

## Structure
- Mirror the source tree: `src/auth/service.ts` → `tests/auth/service.test.ts`.
- Use `describe` / `it` blocks; name tests as behavior specs:
  `it("returns 401 when token is expired")` not `it("test auth")`.

## Coverage expectations
- New code must have ≥ 80% line coverage.
- All public API surface (exported functions, HTTP endpoints) must have tests.
- All error paths must be tested.

## Patterns
- **Arrange-Act-Assert**: structure every test in three clear sections.
- Prefer real implementations over mocks; mock only at system boundaries
  (external APIs, databases in unit tests).
- Use factories/builders for test data; avoid hardcoded magic values.
- Tests must be deterministic — no `Math.random()`, no `Date.now()` without mocking.

## Running tests
Before opening a PR:
```bash
npm test          # run full test suite
npm run test:cov  # check coverage report
```
Do not open a PR if any test fails.
