# Session Log — 2026-07-06 — Round 4: remaining fixes + runtime verification

Branch: `deepreview-fixes-2026-07-06`. Gate: typecheck 23/23 · lint 12/12 · **tests 311/311**.

## What Was Done
Cleared the remaining deferred items from round 3 and ran live runtime verification.

### Fixes
1. **Mirror baseline via real re-fetch (removes the first-pull churn).** Added `fetchItemSnapshot(ref)` to the board connectors (GitHub/Jira/Notion), factoring out the exact normalize/hash helpers their board snapshots use. After a create, the outbox stamps `lastSyncedHash` from `fetchItemSnapshot(remoteId).contentHash` — the SAME code path as the pull — so a platform-auto-assigned status no longer causes a redundant `remoteUpdate`. Re-fetch lives in the outbox finalize step (re-run by a retry), with `createdBaseline` only as fallback. Covers Notion Status-property boards, GitHub status-on-add, and Jira read-back failure.
2. **Link before applied (closes the orphan-on-crash duplicate window).** Create finalize reordered to re-fetch → `linkCreatedItem` (idempotent upsert) → `status:'applied'`; a crash in that window is recoverable via the persisted remoteId + upsert (no second create, no duplicate link).
3. **`PATCH /users/me` JSON schema (defense-in-depth).** `additionalProperties:false` + `name:{type:string,minLength:1}`. Fastify's default ajv `removeAdditional:true` strips role/email/id; `minLength:1` makes a null/empty name a 400 (ajv coerces null→"" otherwise). Handler whitelist retained.

### Guardrails preserved
No deferred-op chaining/deadlock reintroduced; a terminally-failed create still leaves the card local-only without blocking younger ops (test). local_wins gating, idempotency, pull ORDER BY, and all connector fixes intact.

## Verification (real, this session)
- **Gate:** typecheck 23/23 · lint 12/12 · tests **311/311** (10 new mirror re-fetch tests incl. auto-status create → no remoteUpdate; re-fetch failure → op pending, retry re-links with no second create).
- **Runtime (live headless server, isolated HOME, two boots)** — `scratchpad/verify.sh`, all PASS:
  - `/health` 200; web UI served.
  - **CORS rejects** spoofed `http://localhost.evil.com` (no ACAO); allows loopback.
  - **Dev-stub gate:** mints a token WITH `PMOS_DEV_AUTH=1`; **401 WITHOUT** it.
  - **Mass-assignment:** `PATCH {email:attacker,role:viewer}` leaves email/role UNCHANGED.
  - `{name:null}` → 400; legit `{name:"Verified"}` applied; unauth → 401.
- **Renderer boot** (headless Chromium on the real web build): no page errors, `#root` renders SignIn (circular-import crash stays fixed).

## Still open (not bugs)
- LOW: mint-then-persist duplicate if the local persist write fails at the exact instant (inherent; needs provider idempotency key).
- Product/design (single-user v1): connections have no per-user ownership; `requireRole` unwired. Not bugs today; revisit for multi-user.
- Live two-way connector round-trips (GitHub/Jira/Notion/OneDrive) and the Electron GUI/packaged installer — require real tenants / a GUI machine; unverifiable in this sandbox.
