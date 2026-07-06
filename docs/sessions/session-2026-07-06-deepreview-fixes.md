# Session Log — 2026-07-06 — Deepreview fixes + second cross-model deepreview

Branch: `deepreview-fixes-2026-07-06` (off `main` @ `fa66ad6`). Not committed.

## What Was Done
- Implemented fixes for the confirmed findings from the first deepreview (see `session-2026-07-06-deepreview.md`), via 5 parallel domain fix-agents.
- Ran a **second deepreview on the working diff** — 5 fresh domain reviewers + cross-model skeptics (Opus session; skeptics on Fable 5 / Sonnet 5). This caught **6 regressions in the fixes themselves**, which were then fixed.
- Final gate GREEN: `pnpm typecheck` 23/23 · `pnpm lint` 12/12 · `pnpm test` 294/294.
- **Boot smoke test** (headless Chromium against the real `web:build` bundle): PASS — no page errors, `#root` renders the SignIn page. (typecheck could NOT catch the boot crash below — a real browser load was required.)

## Second-pass regressions found (in the fixes) and their resolution
1. **CRITICAL — renderer circular import → boot crash (blank screen).** My 401 fix made `api.ts import store/auth`, which reads `getToken()` at module top → TDZ `ReferenceError` at boot. Reproduced in headless Chromium; invisible to `tsc`. **Fixed:** broke the cycle with a registered-handler pattern (`setUnauthorizedHandler` in `api.ts`; `store/auth.ts` registers `signOut`). Re-verified with a browser load.
2. **HIGH — mirror data-loss fix ineffective + deadlock.** `createdItemContentHash` hardcoded `{state:'open',statusRemoteId:null}` never matches GitHub (`draft`) / Jira (non-null status) on pull → revert persists (F1, skeptic-confirmed). Deferred-op chaining behind a terminally-FAILED create permanently deadlocks that credential's outbox (F2, skeptic-confirmed) — worse than the original bug. **Resolution:** reverted the deferred-op rewrite (`outbox.ts`, `conflicts.ts` + tests) to `main`. Kept only the correct, independent mirror fixes: pull `ORDER BY` (`mirror-sync.ts`) and scheduler teardown (`sync-scheduler.ts`, + a try/catch guard for F6). **The three mirror findings (pre-create-edit data loss, create idempotency, `local_wins` content) remain OPEN — they need a proper redesign (matching pull-side hash via single-item re-fetch; capability-gated reopen).**
3. **HIGH — dev-stub gate broke Electron sign-in.** `CREARE_DEV_AUTH=1` was set only on the headless `server` script; Electron `pnpm dev` / packaged app rely on the dev-stub for Phase-1 silent sign-in. **Fixed:** `index.ts` (Electron entry) defaults `CREARE_DEV_AUTH ??= '1'` — trusted desktop context enabled; bare headless still gated.
4. **HIGH — GitHub status-field bail crashed import.** Bailing `resolveStatusField` to null → `columns:[]` → `applyMirrorSnapshot` throws for a board whose only single-select isn't named "status". **Fixed:** read/write split — new `resolveColumnSourceField` (best-effort single-select) drives columns/reads so import works; the write pointer (`statusFieldRemoteId`, from confident `resolveStatusField`) stays null so moves never hit an unrelated field. Tests updated.
5. **MED-HIGH — `completedToday` dropped null-`completedAt` traces.** The `updateTrace(status:'completed')` pattern leaves `completedAt` null; the fix excluded them forever. **Fixed:** fall back to `startedAt` when `completedAt` is null (keeps the cross-midnight fix for stamped traces).
6. **LOW/MED — Jira 100-page cap silent.** Added a `console.warn` when the snapshot is truncated at the cap.

## Fixes from round 1 that survived the second review as CORRECT
CORS exact-origin match, `PATCH /users/me` whitelist, orphan-secrets guard, CredentialError 422 passthrough, `resolvePort` validation, SIGINT `.finally`, CLI file perms, Jira full pagination + throw-on-4xx (all read connectors), JQL backslash, classifier dead-branch removal, DB enum alignment (type-only, no migration), cost-tracking transaction (sync), `Math.round` cost rounding.

## Files Modified
29 files, +499/−156 vs `main` (see `git diff --name-only main`). Mirror `outbox.ts`/`conflicts.ts` are back at baseline.

## Open Questions / Next Session Should Start With
- **Mirror redesign** (the three deferred findings) is the main remaining work — the pre-create-edit data-loss fix needs the pull-side hash to match (single-item re-fetch after create, or a "locally-authoritative until first real remote change" link flag), plus a non-deadlocking way to chain edits behind an in-flight create, plus capability-gated `reopen`.
- Decide whether to commit this branch (security + connector-read + db fixes are solid and independently valuable) and open the mirror redesign as a separate tracked task.
- Minor leftovers: IPv6 `[::1]` loopback CORS (LOW), `name:null` 500 on `PATCH /users/me` (LOW, pre-existing), residual `'local'`↔`ModelProvider` asymmetry (LOW, pre-existing).
