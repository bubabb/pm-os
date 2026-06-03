---
name: project-agentic-devops-platform
description: "New product concept — an Agentic DevOps platform for building tools, inspired by Azure DevOps but redesigned for AI-agent-native workflows. Captures market research, competitive gaps, and design principles."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7d8f00ae-1b3f-488a-b451-6bedf6f1c748
---

# Agentic DevOps Platform — Project Brief

**Goal:** Build a product that does for AI-agent tool development what Azure DevOps does for traditional software delivery — but natively designed for agentic workflows, multi-agent collaboration, and tool creation as a first-class citizen.

**Why:** Azure DevOps excels at integrated CI/CD but has a clunky UI, stagnant AI features, and was built for human-in-the-loop Agile. GitHub Copilot adds agentic coding but lacks project management, observability, and cross-agent coordination. Neither was designed for the specific workflow of teams building *tools* with and for AI agents.

---

## Market Research — Azure DevOps (2025–2026)

### Strengths to Keep
- **All-in-one integration**: repos + pipelines + boards + testing in one surface — reduces context switching
- **Strong CI/CD engine**: automated deployments, built-in Azure connectors, minimal manual setup
- **Customizable boards**: Scrum/Kanban/custom Agile workflows; stakeholder visibility
- **Microsoft ecosystem fit**: tight Entra/Azure identity and RBAC integration

### Weaknesses to Fix
- **Clunky, outdated UI**: task editing/navigation is slow; non-technical users struggle
- **Steep learning curve**: overwhelming initial experience, especially for non-dev stakeholders
- **Stagnant AI integration**: no meaningful agent-native features; Boards appears to be a sunsetting product
- **Poor reporting for non-technical stakeholders**: dashboards are dev-centric, not PM/exec-readable
- **Licensing fragmentation**: repo access licensed separately — friction and cost bloat
- **Bug backlog**: known issues linger for months; feature velocity > bug fix velocity
- **Half-baked Waterfall support**: designed for Agile; Waterfall bolt-ons are incomplete

---

## Market Research — GitHub Copilot Agentic DevOps (2025–2026)

### Strengths to Keep
- **Best-in-class autocomplete**: fastest, most accurate inline suggestions in the industry
- **Agent Mode**: decomposes tasks into subtasks, executes across files autonomously
- **MCP integration**: connects to external DevOps tools (logs, infra, pipelines) via Model Context Protocol
- **Multi-model flexibility**: GPT-5.4, Claude Sonnet 4.6, Gemini 2.5 Pro — users can pick the right model per task
- **IaC acceleration**: agents can read infra configs, suggest and implement improvements
- **Self-healing**: agents can detect and fix runtime errors in the loop

### Weaknesses to Fix
- **Poor multi-file / large-scope tasks**: struggles beyond 10+ files; ripple-effect errors
- **No team learning**: doesn't adapt to team's review patterns or style conventions
- **Slow cold-boot for cloud agents**: 90+ second spin-up; stop-n-go agent lifecycle is intolerable for interactive workflows
- **Over-automation risk**: broad task prompts produce unintended edits
- **No project management layer**: no boards, backlogs, or sprint tracking
- **No cross-agent observability**: no visibility into what agents are doing, have done, or failed at
- **No tool versioning / registry**: no first-class support for managing AI tool artifacts

---

## What Both Are Missing — Full Feature Gap List (Updated)

### Planning & Visualization
- No native Gantt chart / timeline view (ADO relies on marketplace extensions; Copilot has none)
- No native cross-project roadmap visualization
- No dependency mapping between tasks, milestones, or agents
- No portfolio-level timeline across multiple projects / teams
- No resource / agent capacity planning view
- No critical path analysis
- No milestone tracking with visual progress indicators
- No what-if scenario planning for sprint / release timelines

### AI & Agentic Orchestration
- No agent-native task graph (DAG) — both assume linear/human task execution
- No cross-agent observability (trace viewer, decision log, replay)
- No persistent agent workspaces (cold-boot problem: 90+ sec in Copilot; none in ADO)
- No tool registry for versioning/deploying AI tools as first-class artifacts
- No human-agent approval gate workflow built into task execution
- No multi-agent coordination framework (parallel agents on the same project)
- No agent SLA/SLO tracking (latency, error rate, cost per task)

### Intelligence & Learning
- No team-level memory (neither platform learns from past review decisions or rejections)
- No predictive sprint completion using historical velocity + AI
- No AI-generated risk flags ("this task has high dependency risk based on history")
- No AI-powered retrospectives (auto-summarize what went well/poorly per sprint)
- No deployment risk scoring before a release
- No anomaly detection on build/pipeline health trends

### Reporting & Stakeholder Communication
- No natural language project queries ("what shipped this week?")
- No AI-generated executive summaries of sprint/release status
- No automated changelog / release notes generation
- No business-impact dashboard (links features to business KPIs)
- No SLA/compliance reporting for enterprise audit requirements
- No multi-audience reporting (same data, different views for engineers vs. PMs vs. executives)

### Collaboration & Workflow
- No real-time multiplayer editing on boards or docs (like Notion/Figma)
- No integrated async decision log (why was this decided?)
- No approval workflows for agent-generated code before it enters the pipeline
- No incident management integration (link outages to the tasks/agents that caused them)
- No structured human-agent handoff protocol

### Testing & Quality
- No automated eval harness for AI tool quality (correctness, latency, safety, cost)
- No regression testing framework for prompt/tool changes
- No tool benchmarking across model versions

### Original Core Gaps (retained)
- Agent-native task graph: DAG replacing flat backlogs
- Tool registry & versioning: npm for agent tools
- Cross-agent observability: unified trace/log
- Adaptive team memory: learns from PRs and review patterns
- Instant agent spin-up: sub-5-second, persistent workspaces
- Non-technical stakeholder layer: NL dashboards
- Human-agent handoff protocol: approval gates in the DAG
- Tool testing harness: evals baked into CI

---

## Design Principles

- **Agent-first, human-supervised**: agents do the work; humans set intent and approve gates
- **Tool as artifact**: every tool built on the platform is versioned, tested, and deployable like code
- **Observability by default**: every agent action is logged, traceable, and replayable
- **Zero cold-start**: agent workspaces are always warm
- **Model-agnostic**: works with Claude, GPT, Gemini, open-source LLMs
- **Composable**: built on open standards (MCP, OpenAPI) so it integrates with existing DevOps stacks

---

## Next Steps (TBD with user)
- [ ] Define core MVP feature set
- [ ] Name / brand the product
- [ ] Architecture design (agent orchestration layer, tool registry schema, pipeline model)
- [ ] Identify target user persona (AI platform teams? indie tool builders? enterprise DevOps?)
- [ ] Competitive differentiation vs. emerging players (Devin, SWE-agent, Factory.ai)

**Product name: Creare** (Latin: "to create") — confirmed clear, no conflicts in DevOps/AI space. Domain: creare.dev (available). Locked in 2026-06-02.

**Master scope document:** `/Users/bubagv/Desktop/devops_platform/project-scope.md` — this is the authoritative reference for all decisions. Read it before making any architectural, feature, or UX call.

**Deployment model decision:** Local-first Electron desktop app for v1 (single user, SQLite, fully offline). Team collaboration via optional sync server in v2 — architected for from day 1 using UUIDs everywhere, append-only event log, and conflict-aware data models. No rewrite needed to add team mode.

**Approved tech stack (2026-06-02):** TypeScript everywhere · Turborepo + pnpm · Electron + electron-vite · Electron Forge (packaging) · React + Tailwind + shadcn/ui · Zustand + TanStack Query · Fastify (localhost HTTP) · SSE for real-time · Electron Utility Processes (agent execution) · SQLite + Drizzle ORM · Append-only event log · Model-agnostic SDK wrapper (Phase 1 task) · MCP TypeScript SDK · Vitest + Playwright · ElectricSQL v2 (PowerSync fallback)

**Phase 0 status: COMPLETE (2026-06-02)**
All 5 Phase 0 tasks done. 5 commits on `main`. 84 files. Fully reviewed twice.
Repo: `/Users/bubagv/Desktop/devops_platform/`
Schema: 20 tables, SCHEMA_VERSION 1.1.0, 10 indexes, 3 append-only tables
Task instruction files: `docs/agents/tasks/phase1-task4/5/6/17.md` — Phase 1 unblocked
**Phase 1 next:** Tasks #4 (auth/secrets) + #5 (DB/API) can run in parallel. Task #6 (UI shell) blocked by #5. Task #17 (notifications) blocked by #5.

**How to apply:** Use this document to inform all architectural, feature, and UX decisions for this project. Prioritize the "What Both Are Missing" section when scoping the MVP.

---

## Development Framework — Domain-Driven Iterative Development

### Why This Fits Claude Code
Claude works best with bounded context — one focused domain at a time, with clear file boundaries and persistent instructions. A monolithic or layer-first approach (all frontend, then all backend) causes context bleed and makes it hard to iterate.

### The 5-Phase Structure

**Phase 0 — Foundation (1–2 sessions)**
- Set up the repo with a root `CLAUDE.md` (project rules, stack, conventions)
- Define tech stack, data models, auth strategy
- Scaffold the monorepo folder structure with per-domain `CLAUDE.md` files

**Phase 1 — Core Infrastructure**
- Auth/RBAC, database, API layer, base UI shell
- Nothing domain-specific yet — just the backbone

**Phase 2 — Domain Modules (iterative sprints)**
Each domain is a self-contained sprint:
1. `agent-orchestration` — DAG engine, warm workspaces
2. `tool-registry` — versioning, deploy, artifact storage
3. `observability` — trace viewer, decision log
4. `boards` — planning, backlog, sprint tracking
5. `reporting` — NL queries, stakeholder dashboards

**Phase 3 — Integration**
- Wire domains together, cross-domain APIs, E2E flows

**Phase 4 — Eval & Quality**
- AI eval harness, regression testing for tools, benchmarking

### Key Claude Code Practices Per Phase
| Practice | Purpose |
|---|---|
| `CLAUDE.md` per domain folder | Claude stays in scope per sprint |
| Memory file per major decision | Decisions survive across sessions |
| `TaskCreate` at session start | Claude tracks progress within a session |
| Verify skill after each feature | Confirm it works before moving on |

### Main Tradeoff
Domain-driven means building vertically (full stack per domain) rather than horizontally (all DB first, then all API). Slower to see a "complete" layer but much faster to have shippable, testable features — and Claude handles it far better.
