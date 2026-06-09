# Session Log — 2026-06-09 — Phase 4 (Eval & Intelligence)

Phase 4 per `project-scope.md`: **"AI eval harness, regression testing, team memory /
adaptive learning."** Built all four workstreams in dependency order. **Nothing has been
run** — Kali has no toolchain; this must be `pnpm install`-ed and `pnpm test`-ed on the Mac.

## Workstream 1 — Test foundation
- `vitest.config.ts` (root): aliases every `@creare/*` package to its **TypeScript source**
  (anchored regexes so `@creare/database` doesn't shadow `@creare/database/testing`), node
  env, globals on, includes `packages/**` + `apps/**` test globs. Running against source
  decouples tests from the build.
- `package.json` (root): `test` → `vitest run` (was a no-op `turbo run test`), plus
  `test:watch` / `test:coverage`; added `vitest` + `@vitest/coverage-v8` devDeps.
- `tsconfig.base.json`: excludes `**/*.test.ts(x)`, `**/*.spec.ts`, `**/testing.ts` so
  test-only files (which use `import.meta.url`) never enter the CommonJS package builds.
- `@creare/database`:
  - `client.ts` — added `setDb()` / `resetDb()` to inject a connection.
  - `testing.ts` (NEW, build-excluded) — `createTestDb()` builds an in-memory SQLite DB and
    applies the real migrations via the drizzle migrator; `seedUser/seedProject/seedTask/seedWorkspace`
    fixtures; `destroyTestDb()`.
- Seed regression suites (double as coverage for the Phase 3 fixes):
  `shared/id`, `tool-registry` (publish repoint, single-active deploy, rollback, FK guards),
  `boards` (column seeding, single-active sprint, guarded updateColumn, item+task join),
  `agent-orchestration` (edge add, self-loop, duplicate, **cycle detection**, cross-project
  reject, getReadyTasks dependency gating).

## Workstream 2 — Tool regression harness  (`packages/eval`)
- `tool-regression.ts`: `runToolRegression({tool,version}, executor, cases)` with default
  `deepEqual` matcher and per-case diffs; `validateToolSchema(json)`. Takes a `ToolExecutor`
  the caller supplies (no execution engine exists yet — the harness is ready for when it lands).

## Workstream 3 — AI eval harness  (`packages/eval`)
- `types.ts`, `scorers.ts` (`exactMatch`, `includes`, `regexMatch`), `eval-runner.ts`
  (`runEval` → aggregate pass rate / avg score, error-isolating per case).
- `model-runner.ts`: `makeModelRunner` and `makeLlmJudge` over `@creare/ai-sdk` `complete()`.
- `persistence.ts`: `persistEvalRun` / `listEvalRuns` against the new `eval_runs` table.
- Tests use stub runners/executors — no live API needed.

## Workstream 4 — Team memory / adaptive learning  (`packages/memory`)
- `recordLearning` (+ append-only event), `listLearnings`, `recallLearnings`
  (tag-overlap + keyword ranking; recent-first when no query). Backed by `learnings` table.

## Schema (`@creare/database`)
- New tables `eval_runs` and `learnings` + types; `SCHEMA_VERSION` → `1.3.0`.
- Migration `0002_phase4_eval_intelligence.sql` + `_journal.json` entry (idx 2). The
  migrator applies journal+SQL at runtime; **no meta snapshot was generated** — run
  `pnpm --filter @creare/database db:generate` on the Mac if you want drizzle-kit diffs to
  stay coherent for future migrations.

## Verification — REQUIRED on the Mac
```
pnpm install            # new packages (eval, memory) + root vitest deps
pnpm -r exec tsc --noEmit
pnpm test               # runs all 8 suites via the root vitest config
```

## Not done (deliberate follow-ups)
- Domain test coverage is seeded for 4 of 6 domains + the 2 new packages; observability,
  integrations, and reporting still need suites.
- No desktop routes/UI for eval or memory yet (Phase 4 shipped the library/intelligence layer).
- Playwright E2E (the deferred Phase 3 "E2E flows") still outstanding.
- All Phase 3 work is still uncommitted — verify + commit that on the Mac too.
