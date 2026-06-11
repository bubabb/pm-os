# Session Log — 2026-06-11 — claude-cli provider (membership auth)

## What Was Done
- Added a new `claude-cli` model provider to `packages/ai-sdk` that uses the Claude
  membership/subscription login instead of a pay-per-token API key.
- It shells out to the local Claude Code CLI in headless print mode
  (`claude -p --output-format json --model <m> [--append-system-prompt <s>]`),
  writing the rendered prompt to stdin and parsing the JSON result.
- Typechecks clean; verified end-to-end (real call via membership, returned content +
  token counts + cost).

## Decisions Made
- **No API key for this provider.** `complete()`'s `apiKey` param is now optional;
  `claude-cli` is dispatched before the key check, and the API-key providers
  (anthropic/openai/gemini) throw if `apiKey` is undefined. Keeps existing callers working.
- **Cost reporting:** surface the CLI's `total_cost_usd` as `costCents` for observability,
  even though the membership (not a key) actually pays. Documented inline.
- **Print-mode limits:** no `temperature`/`maxTokens` flags exist in print mode, so those
  request fields are ignored for `claude-cli` (documented in the provider).
- Multi-turn messages are rendered into a single Human/Assistant transcript since print
  mode is one turn; a lone user message passes through verbatim.

## Files Created or Modified
- NEW `packages/ai-sdk/src/providers/claude-cli.ts`
- `packages/ai-sdk/src/types.ts` — added `'claude-cli'` to `ModelProvider`
- `packages/ai-sdk/src/index.ts` — import + dispatch + optional `apiKey`

## Open Questions
- The CLI inherits the working directory's project context (it loads the cwd `CLAUDE.md`).
  For deterministic SDK/eval calls we may want to run it from a neutral cwd or add flags to
  exclude project context. Not addressed this session.
- `inputTokens` reports only `usage.input_tokens` (excludes cache_read/cache_creation), matching
  the anthropic API provider. Revisit if observability wants cache tokens counted.

## Part 2 — make EVERYTHING default to the CLI (no API key)
- Added `providerNeedsKey()` and `llmAvailable(provider, apiKey)` helpers to `@creare/ai-sdk`
  (single source of truth for "does this provider need a key / is the model callable").
- New shared resolver `apps/desktop/src/main/secrets/reasoning-config.ts`:
  `resolveReasoningConfig()` + `VALID_PROVIDERS`/`DEFAULT_REASONING_PROVIDER` (now `claude-cli`)
  /`DEFAULT_REASONING_MODEL`. `ReasoningConfig.apiKey` is now `string` ('' when no key needed).
- Both `routes/reporting.ts` and `routes/eval.ts` now use the shared resolver and gate the
  422 "API key not configured" error behind `providerNeedsKey(provider)` — so claude-cli runs
  with no key. Removed the duplicated per-file config blocks.
- `routes/global-settings.ts` `/settings/reasoning-defaults` now falls back to the shared
  `claude-cli` defaults instead of hardcoded `anthropic`.
- `reporting/pm-command-center.ts` `getDashboard` now gates classification on
  `llmAvailable(provider, apiKey)` instead of the API key's truthiness (empty key under
  claude-cli is still callable).
- Renderer `ConnectionsPage.tsx`: added `claude-cli` to the reasoning-model picker (3
  "(membership)" options, always selectable, no key), made `isProviderConnected('claude-cli')`
  always true, and reworded the section — provider API keys are now optional.
- Verified: full `pnpm -r build` ✅, `pnpm -r typecheck` ✅ (12/12), `pnpm test` ✅ 73/73
  (added `llmAvailable` to the pm-command-center test's ai-sdk mock).

## Decisions Made (part 2)
- Default provider is `claude-cli` (membership). The keyed providers remain selectable as
  overrides — not removed — so this is a default change, not a hard lock-in.
- `apiKey` resolves to `''` (not null) so it satisfies the downstream `apiKey: string`
  params; `complete()` ignores it for claude-cli.

## Part 3 — startup health-check for the membership/CLI
- Added `checkClaudeCli()` + `ClaudeCliHealth` to `@creare/ai-sdk` (in `providers/claude-cli.ts`).
  FREE/fast probe (no model call, no token spend): runs `claude --version` for the binary, then
  reads `~/.claude/.credentials.json` `claudeAiOauth` (accessToken+refreshToken) to verify
  membership sign-in. Reports `authenticated: yes | no | unknown`. macOS Keychain case →
  'unknown' (soft, not a false "not signed in"); on Linux a missing token → 'no'. Expired
  accessToken with a refreshToken still counts as signed in (CLI auto-refreshes).
- Route `GET /settings/claude-cli-health` (requireAuth) in `routes/global-settings.ts`.
- `server.ts` runs the check once after `listen()` — NON-blocking — and logs a clear terminal
  line: `[creare] reasoning (claude-cli): …` (warn when not ok).
- Renderer `ConnectionsPage.tsx`: new `MembershipStatusCard` at the top of the AI Models
  section — green "Signed in · <plan>", amber "Unverified" (macOS), or red "Not signed in / CLI
  not found" with the actionable message + a Recheck button (query key `claudeCliHealth`).
- Verified at runtime: `checkClaudeCli()` → `{ ok:true, authenticated:'yes', subscriptionType:'max' }`.
- Re-verified: `pnpm -r typecheck` ✅, `pnpm -r build` ✅, `pnpm test` ✅ 73/73.

## Part 4 — cross-platform credential stores (macOS Keychain + Windows Cred Manager)
- Reworked the health probe in `providers/claude-cli.ts` into a layered `resolveMembershipOauth()`:
  - File first (`~/.claude/.credentials.json`) — Linux/Windows default, sometimes macOS too.
  - macOS fallback → `security find-generic-password -s "Claude Code-credentials" -w`
    (exit 44 = item-not-found → 'absent'; other failure → 'unknown').
  - Windows fallback → PowerShell Win32 `CredRead` for target "Claude Code-credentials",
    blob emitted as base64 and decoded UTF-8→UTF-16LE (keyring versions differ).
  - Linux with no file → 'absent'.
- Three-state lookup (`found`/`absent`/`unknown`) maps to `authenticated: yes/no/unknown`.
  'unknown' now means the store was genuinely unreadable, not "macOS so we gave up".
- `CREDENTIAL_SERVICE = 'Claude Code-credentials'` constant shared by both OS probes.
- Added a generic `runCapture()` (fixed `['pipe','pipe','ignore']` stdio so streams type
  non-null under strict mode); `claudeVersion()` now uses it too.
- Verified: Linux file path still `{ ok:true, authenticated:'yes', subscriptionType:'max' }`;
  base64↔UTF-8/UTF-16LE decode round-trips; missing binary → 'unknown' (no crash).
  `pnpm -r typecheck` ✅, `pnpm -r build` ✅, `pnpm test` ✅ 73/73.

## Part 5 — dev diagnostic script
- Added `scripts/check-claude-cli-auth.mjs` + root npm script `pnpm check:auth`.
- Read-only (no model call, no token spend). Prints: environment (platform + `claude --version`),
  a per-store breakdown (file / macOS Keychain / Windows Cred Manager), and the canonical
  `checkClaudeCli()` result the app sees.
- The macOS/Windows sections probe CANDIDATE_NAMES ('Claude Code-credentials', 'Claude Code',
  'claude-code', 'claude') and show which entry name actually holds the credential — so you can
  confirm/fix `CREDENTIAL_SERVICE` in `providers/claude-cli.ts` from one command on each OS.
- Imports the built `@creare/ai-sdk` dist by relative path (root can't resolve the workspace
  pkg); prints a clear "run pnpm --filter @creare/ai-sdk build" hint if dist is missing.
- Verified on Linux: shows file store FOUND (sub=max) + status ok.

## Next Session Should Start With
- Decide on cwd/context isolation for `claude-cli` (the CLI loads the cwd `CLAUDE.md`) so
  reporting/eval calls aren't polluted by whatever directory the Electron main process runs in.
- Optional: prune the now-effectively-optional API-key UI cards, or keep as override path.
- On the Mac and a Windows box: run `pnpm check:auth` and confirm `CREDENTIAL_SERVICE`
  ('Claude Code-credentials') matches the real entry name; adjust the constant if not.
