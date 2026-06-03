# Creare — Project Scope
**Product Name:** Creare  
**Domain:** creare.dev  
**Version:** 1.2  
**Date:** 2026-06-02  
**Status:** Active — Master Reference Document

> *Creare — Latin: "to create." The platform where AI-native software teams build, ship, and operate their work.*

## Change Log
| Version | Date | Change | Impact |
|---|---|---|---|
| 1.0 | 2026-06-02 | Initial scope document | All phases |
| 1.1 | 2026-06-02 | Added local-first Electron deployment model + sync-readiness constraints | Phase 1 DB, all Phase 2 domains |
| 1.2 | 2026-06-02 | Added 8 missing features: secrets mgmt, agent permissions, notifications, multi-project workspace, rollback, audit log, backup/recovery, global search, project templates, usage/cost tracking, rate limiting | Phase 1 + Phase 2 scope expanded |
| 1.3 | 2026-06-03 | Added Domain 6: Integrations — external source connectors (Jira, GitHub, Confluence, Notion, OneDrive), OAuth credential store, background sync engine, cross-source entity correlation, two-stage PM action classifier, PM digest generation. PM Command Center dashboard added as first Phase 2 deliverable under Domain 5 + Domain 6. | New domain, 5 new schema tables, Phase 2 build order updated |

---

## 1. Vision Statement

Build the definitive DevOps platform for the AI-agent era — combining everything Azure DevOps and GitHub Copilot do well, eliminating their most complained-about failures, and adding a layer of agentic intelligence that neither platform was designed to support.

Creare is not an incremental improvement. It is a ground-up redesign of the software delivery lifecycle with AI agents as first-class participants alongside human engineers, PMs, and stakeholders.

---

## 2. Problem Statement

### What Azure DevOps gets right — but breaks in practice
Azure DevOps delivers an all-in-one surface (repos, pipelines, boards, testing) that reduces context switching. Its CI/CD engine is robust, its Agile boards are customizable, and its Microsoft/Entra integration is enterprise-grade.

**But it consistently fails users because:**
- The UI is clunky, slow, and outdated — non-technical users regularly abandon it
- Onboarding is overwhelming; the learning curve is steep for anyone outside core engineering
- AI integration is effectively absent — Boards is reportedly being sunset with no agentic replacement
- Dashboards are dev-centric; PMs and executives can't extract value without custom tooling
- Licensing is fragmented — repo access is separately licensed, causing cost and friction
- Known bugs linger for months; feature velocity outpaces quality

### What GitHub Copilot Agentic DevOps gets right — but breaks in practice
GitHub Copilot delivers the best inline autocomplete in the industry. Its Agent Mode decomposes tasks and executes autonomously. MCP integration connects it to external tools. Multi-model flexibility (Claude, GPT, Gemini) is best-in-class.

**But it consistently fails users because:**
- Struggles with large-scope changes (10+ files); ripple-effect errors compound fast
- No team learning — ignores established review patterns and style conventions
- 90+ second cold-boot for cloud agents; stop-and-go lifecycle kills interactive workflows
- Broad task prompts produce unintended edits with no guardrails
- No project management layer — no boards, no backlogs, no sprint tracking
- No cross-agent observability — no visibility into what agents are doing or have done
- No tool versioning or registry — AI tools are invisible artifacts

### The Gap Neither Fills
No platform today was designed for teams whose primary output is **AI tools and agent pipelines**. The workflow of building, testing, deploying, and operating agent-native software has no dedicated DevOps surface.

---

## 3. Target Users

This is a platform play. All three personas are first-class users.

### Persona 1 — AI Platform Team (Enterprise)
**Who:** Engineering teams at mid-to-large companies building internal AI tools, agent pipelines, and LLM-powered products.  
**Needs:** RBAC, compliance reporting, SSO/Entra integration, audit logs, SLA tracking, multi-team coordination.  
**Pain today:** Azure DevOps has the structure but not the AI. Copilot has the AI but not the structure.

### Persona 2 — DevOps / MLOps Engineer
**Who:** Engineers already running CI/CD pipelines who want to layer agentic automation on top of their existing stack.  
**Needs:** MCP integrations, OpenAPI connectors, pipeline compatibility, infra-as-code support, low-friction adoption.  
**Pain today:** Every agent tool is a custom script with no versioning, testing, or observability.

### Persona 3 — Indie AI Tool Builder / Small Team
**Who:** Solo developers and small teams shipping AI-powered products and tools.  
**Needs:** Fast onboarding, low friction, no enterprise overhead, powerful defaults.  
**Pain today:** Stitching together GitHub + Notion + custom eval scripts + observability tools is expensive and brittle.

### Secondary User — Non-Technical Stakeholder (PM / Executive)
**Who:** Product managers, executives, and clients who need project visibility without dev-tool fluency.  
**Needs:** Natural language dashboards, AI-generated summaries, business-impact reports.  
**Pain today:** Both Azure DevOps and GitHub Copilot produce dev-centric output that requires translation.

---

## 4. Product Pillars

Every feature must serve at least one of these five pillars.

| # | Pillar | What It Means |
|---|---|---|
| 1 | **Agent-Native Execution** | Agents are first-class task executors, not bolt-ons. The platform is designed around agent + human collaboration. |
| 2 | **Tool as Artifact** | Every AI tool built on the platform is versioned, tested, deployable, and discoverable — like code packages. |
| 3 | **Observability by Default** | Every agent action is logged, traceable, and replayable. No black boxes. |
| 4 | **Stakeholder Intelligence** | The platform translates engineering activity into language PMs and executives can act on — automatically. |
| 5 | **Composable by Design** | Works with existing stacks via open standards (MCP, OpenAPI). Replaces what's broken; integrates with what works. |

---

## 5. Full Feature Scope (MVP — All Domains)

### Domain 1: Agent Orchestration
The core differentiator. Replaces flat backlogs with agent-native task graphs.
- DAG-based task engine (directed acyclic graph replacing linear backlogs)
- Persistent warm agent workspaces — sub-5-second spin-up, always-on
- Multi-agent coordination: parallel agents on the same project without conflicts
- Human-agent approval gates built into task execution flow
- Structured human-agent handoff protocol
- Agent SLA/SLO tracking: latency, error rate, cost per task
- Over-automation guardrails: scope boundaries, confirmation thresholds
- **Agent permission scoping** — each agent gets explicit, bounded permissions: which tools it can call, which repos it can access, which secrets it can use. Separate from human RBAC.
- **Rate limiting & cost guardrails** — hard caps and soft warnings on model API calls per agent per day. Prevents runaway costs on bad runs.

### Domain 2: Tool Registry
The npm for AI tools. Makes agent tools versioned, deployable, and discoverable.
- Tool versioning and publishing workflow
- Artifact storage and deployment pipeline
- Tool discovery and search UI
- Dependency graph between tools
- Automated compatibility checks across model versions (Claude, GPT, Gemini)
- Tool usage analytics and performance history
- **One-click rollback** — pin any deployment to a previous version and redeploy instantly. Versioning without rollback is incomplete.

### Domain 3: Observability
Makes the platform trustworthy. Full visibility into agent behavior.
- Cross-agent trace viewer with timeline and decision tree
- Decision log: why did the agent do that?
- Replay engine: rerun any agent execution from any point
- Anomaly detection on build and pipeline health trends
- Incident management integration: link outages to the agents/tasks that caused them
- Deployment risk scoring before a release
- **Immutable audit log** — separate from traces. Records who authorized what, when, and why. Tamper-proof, human-readable. Required for SOC2/HIPAA/enterprise compliance. Not the same as observability traces.

### Domain 4: Boards & Planning
The Azure DevOps replacement layer, rebuilt for humans and agents.
- Kanban and Scrum boards with customizable workflows
- Native Gantt / timeline view (no marketplace extension required)
- Dependency mapping between tasks, milestones, and agents
- Portfolio-level roadmap across multiple projects/teams
- Resource and agent capacity planning view
- Critical path analysis
- Milestone tracking with visual progress indicators
- What-if scenario planning for sprint and release timelines
- Real-time multiplayer board editing (Notion/Figma-style collaboration)
- Async decision log: why was this decided?

### Domain 5: Reporting & Stakeholder Intelligence
Turns engineering activity into executive-readable intelligence automatically.
- Natural language project queries ("what shipped this week?")
- AI-generated executive summaries of sprint and release status
- Automated changelog and release notes generation
- Multi-audience dashboards: same data, different views for engineers / PMs / executives
- Business-impact dashboard linking features to KPIs
- SLA and compliance reporting for enterprise audit requirements
- AI-powered retrospectives: auto-summarize what went well and poorly per sprint
- Predictive sprint completion using historical velocity and AI
- **Usage & cost tracking** — per-project, per-agent breakdown of model API calls and spend. Teams can budget, audit, and cap AI costs from within the platform.
- **PM Command Center** — the first Phase 2 deliverable. A triage dashboard that aggregates internal Creare data (sprints, milestones, traces) with external source data from Domain 6 (Integrations) to give the PM a single surface for daily action. Four zones: Morning Brief (DO NOW panel), Sprint Health, Decisions & Docs, and Risk Radar. Every risk item has a one-click response: [Handle it] (routes to DO NOW) or [Delegate▶] (creates an agent task via Domain 1). Built on top of Domain 6's sync layer — Domain 5 reads, Domain 6 fetches.

### Domain 6: Integrations
The external connectivity layer. Fetches, normalizes, and caches data from external DevOps and productivity tools. Enables Creare to be the PM's single surface without requiring teams to migrate away from their existing stack.

- **External source connectors** — Jira (MCP), GitHub (MCP), Confluence (Atlassian REST v2), Notion (REST), OneDrive (Microsoft Graph / MSAL). Each connector is a self-contained module with its own auth, pagination, and normalization logic.
- **OAuth 2.0 credential management** — stores and refreshes OAuth tokens per source per project. Uses the Phase 1 secrets layer (AES-256-GCM encryption) — tokens are never stored in plaintext.
- **Background sync engine** — 15-minute polling per source with cursor-based pagination. Manual "refresh now" always available. Sync state (last cursor, last synced timestamp, error status) tracked per credential.
- **External event normalization** — all external events (Jira tickets, GitHub PRs, Confluence pages, Notion notes, OneDrive meeting files) are converted to a unified internal schema before caching. Domain 5 and Domain 1 consume normalized data only — never raw API responses.
- **Cross-source entity correlation** — links entities across sources by matching identifiers. MVP: Jira ticket IDs in GitHub PR titles and branch names (e.g. `PROJ-89` in `feature/PROJ-89-auth-flow`). Extensible to full graph correlation in v2.
- **Two-stage PM action classifier** — routes normalized events to the correct dashboard panel (DO NOW for human-required actions, DELEGATE for agent-executable actions). Stage 1: fast rule engine (no LLM cost) for obvious cases. Stage 2: LLM fallback for ambiguous items. Returns `{ bucket, urgency, riskType, suggestedAction }` per item.
- **PM digest generation** — produces structured digests for each PM Command Center zone (morning brief, sprint health, decisions & docs, risk radar). Results cached in `pm_digest_cache` with a `validUntil` expiry — stale digests are regenerated automatically on next dashboard load.
- **Integration health monitoring** — tracks sync status, error rates, and credential expiry per source. Surfaces integration failures as notifications before they cause stale data problems.

### Cross-Cutting Infrastructure
These features span all domains and must be built in Phase 1 before domain work begins.

- **Secrets & environment management** — encrypted storage for API keys, tokens, and environment variables. Scoped per project and per agent. Never exposed in logs, traces, or UI. This is Phase 1 critical — every agent call depends on it.
- **Notifications & alerts** — in-app, email, and Slack notifications for: approval gates waiting, agent failures, deployment completions, cost threshold warnings. Without this, human-agent collaboration is broken.
- **Multi-project / workspace management** — users manage multiple projects. First-class UI for creating, switching, archiving, and organizing projects. The workspace model underpins everything.
- **Global search** — cross-domain search across all entities: tasks, tools, agents, traces, decisions, docs. Mandatory for usability at scale.
- **Local backup & recovery** — scheduled automatic SQLite backups with one-click restore. A corrupted database without recovery means total data loss.
- **Project templates & onboarding** — starter templates ("New AI Tool Project", "New Agent Pipeline", "New DevOps Project") to hit the 15-minute onboarding target. Without templates, new users face an empty platform and churn.

---

## 6. Out of Scope (Version 1)

The following are explicitly excluded from v1 to maintain focus:

- Native code editor / IDE (we integrate with VS Code, Cursor, etc. — we do not replace them)
- Mobile app (web-first; mobile-responsive but no native app)
- On-premise self-hosted deployment (cloud-first; self-hosted is a v2 enterprise tier)
- Custom LLM fine-tuning or model training (we consume models; we do not train them)
- Customer support / ticketing system (this is a DevOps platform, not a helpdesk)
- Social / community features (no public profiles, feeds, or marketplace in v1)

---

## 7. Design Principles

These are non-negotiable. Every architectural and UX decision must be measured against them.

1. **Agent-first, human-supervised** — agents execute; humans set intent and approve gates. Never the reverse.
2. **Tool as artifact** — every AI tool is versioned, tested, and deployable like code. No invisible scripts.
3. **Observability by default** — every agent action is logged, traceable, and replayable. Opt-out, not opt-in.
4. **Zero cold-start** — agent workspaces are always warm. 90-second spin-ups are a dealbreaker we are solving.
5. **Model-agnostic** — works with Claude, GPT, Gemini, and open-source LLMs. No vendor lock-in.
6. **Composable** — built on MCP and OpenAPI. Integrates with GitHub, Azure Pipelines, Jira, Slack, and cloud infra.
7. **Stakeholder-readable by default** — every piece of engineering data has a plain-language representation available.
8. **Opinionated defaults, flexible overrides** — powerful out of the box; customizable without breaking the model.

---

## 8. Technical Direction

**Status: Approved 2026-06-02**

### Deployment Model: Local-First, Team-Ready

**v1 — Single user, local:**
- Electron desktop app: installs like VS Code, no Docker or terminal required
- Embedded local database (SQLite) — all data stays on the user's machine
- Fully offline capable

**v2 — Team collaboration (architected for from day 1):**
- Optional sync server unlocks real-time team collaboration
- Local SQLite syncs to a central Postgres instance when a server is present
- Same Electron app, same codebase — team mode is an opt-in upgrade, not a rewrite

### Approved Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | Everywhere — frontend, backend, shared types |
| Monorepo | Turborepo + pnpm | Fast builds, cross-package dependency management |
| Desktop shell | Electron + electron-vite | `electron-vite` handles multi-process build (main, preload, renderer) |
| Packaging | Electron Forge | Builds, auto-updates, distribution |
| UI | React + Tailwind + shadcn/ui | shadcn/ui = copy-owned components on Radix UI |
| State management | Zustand + TanStack Query | Zustand for global state; TanStack Query for async/server state |
| Local API | Fastify (localhost HTTP, v1) | HTTP from day 1 for web-compatibility in v2; localhost-only, no external exposure |
| Real-time | Server-Sent Events (SSE) | Live agent updates and observability stream; upgrade to WebSockets for v2 collaboration |
| Agent execution | Electron Utility Processes | Isolated, non-blocking agent runtime; each task runs in a utility process |
| Database | SQLite + Drizzle ORM | Local-first, zero-setup, TypeScript-native migrations |
| Event log | Append-only SQLite table | Immutable event stream — powers observability and future sync |
| Agent/AI | Model-agnostic SDK wrapper | Custom wrapper over Anthropic, OpenAI, Gemini SDKs — Phase 1 dedicated task |
| MCP | MCP TypeScript SDK | External tool connectivity via Model Context Protocol |
| Testing | Vitest + Playwright | Unit/integration + E2E across Electron |
| Sync (v2) | ElectricSQL (pinned version) | SQLite → Postgres; PowerSync is fallback if ElectricSQL breaks again |

### Architectural Constraints for Sync-Readiness
These must be enforced from the first line of code:
- **UUIDs everywhere** — no auto-increment IDs
- **Append-only event log** — all state changes are events, not mutations
- **Conflict-aware data models** — CRDT-friendly merge semantics on all schemas
- **No server-assumed features in v1** — sync is additive, not foundational

### Known Constraints
- Must support MCP integration for external tool connectivity
- Must be model-agnostic — no hard dependency on a single LLM provider
- Auth must support Microsoft Entra (SSO) and GitHub OAuth as first-class providers
- API layer must be OpenAPI-spec compliant
- All agent actions must produce structured, queryable trace logs

### Architecture Target
- Monorepo with per-domain module boundaries
- Each domain has its own `CLAUDE.md` for scoped AI-assisted development
- Event-driven communication between domains via append-only event log
- Electron shell + electron-vite + Fastify local server + SQLite
- Sync layer added in v2 via ElectricSQL (SQLite → Postgres)

---

## 9. Development Framework

Development follows a 5-phase Domain-Driven Iterative structure optimized for Claude Code.

| Phase | Name | Deliverable |
|---|---|---|
| **0** | Foundation | Tech stack decision, monorepo scaffold, core data models, this scope document |
| **1** | Core Infrastructure | Auth/RBAC, database, API layer, base UI shell |
| **2** | Domain Modules | All 6 domains built as self-contained iterative sprints. Build order: Domain 6 (Integrations) first, then Domain 5 (Reporting / PM Command Center), then Domains 1–4 in parallel. |
| **3** | Integration | Cross-domain wiring, E2E flows, MCP/external integrations |
| **4** | Eval & Intelligence | AI eval harness, regression testing, team memory/adaptive learning |

**Claude Code practices applied throughout:**
- `CLAUDE.md` at root and per domain — persistent context for every session
- Memory files for all major decisions — nothing is lost between sessions
- `TaskCreate` at the start of each session — progress is always tracked
- Verify skill used after every feature — nothing ships unconfirmed

---

## 10. Success Metrics (MVP)

| Metric | Target |
|---|---|
| Agent workspace spin-up time | < 5 seconds |
| Cross-agent trace coverage | 100% of agent actions logged |
| Stakeholder dashboard adoption | PM/exec users can answer project questions without engineering help |
| Tool registry publish-to-deploy time | < 2 minutes end-to-end |
| Platform onboarding time | New user productive in < 15 minutes |
| Azure DevOps feature parity | All "Strengths to Keep" features matched or exceeded |
| GitHub Copilot feature parity | All "Strengths to Keep" features matched or exceeded |

---

## 11. How Claude Should Use This Document

This is the **master reference document** for all development decisions on this project. When in doubt about scope, direction, or priorities — consult this document first.

- **Scoping questions:** Check Section 5 (in scope) and Section 6 (out of scope) before adding any feature.
- **Design decisions:** Measure against Section 7 (Design Principles) — if it violates a principle, do not build it.
- **Architecture decisions:** Align with Section 8 (Technical Direction) — flag any deviation for explicit approval.
- **Prioritization:** The five Product Pillars (Section 4) are the tiebreaker when two features compete for resources.
- **User empathy:** Every feature should be traceable back to a pain point in Section 2 or a persona need in Section 3.
