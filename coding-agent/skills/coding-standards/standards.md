# Coding Standards for blueberry

## General principles
- Write self-documenting code; avoid comments that restate what the code does.
- Prefer explicit over implicit.
- Keep functions small and single-purpose.
- No dead code, commented-out blocks, or unused imports.

## TypeScript / JavaScript
- Use TypeScript strict mode.
- Prefer `const` over `let`; avoid `var`.
- Use named exports; avoid default exports except for React components.
- Type all function parameters and return values explicitly.
- Use `zod` for runtime validation at system boundaries (API inputs, env vars).
- Avoid `any`; use `unknown` and narrow with type guards.

## Go
- Target the Go toolchain pinned in `go.mod` — currently `go 1.26.4` with
  `toolchain go1.26.4`. Do NOT downgrade the `go` or `toolchain` directives;
  `GOTOOLCHAIN=auto` fetches the pinned toolchain automatically.
- Keep `gofmt` and `go vet ./...` clean. Handle every returned `error`
  explicitly — never discard one with `_`.
- Prefer the standard library; add dependencies only when they clearly earn it.

## File organization
- Group by feature, not by type (e.g. `auth/` contains handler + service + types).
- Keep files under ~300 lines; split if larger.
- Index files (`index.ts`) re-export only — no logic.

## Error handling
- Use typed errors; never throw plain strings.
- Surface errors at system boundaries; let internal errors propagate naturally.
- Log errors with structured context (include relevant IDs).

## Git
- Branch names: `linear/<ticket-id>` (e.g. `linear/ENG-42`).
- Commit messages: imperative mood, reference ticket ID in footer.
  ```
  feat: add user authentication

  Implements JWT-based auth with refresh tokens.

  Linear: ENG-42
  ```
- One logical change per commit.
