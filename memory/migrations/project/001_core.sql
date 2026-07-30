-- memory_<slug> 001 — one project's memory. Applied identically to every project database.
--
-- TWO CLASSES OF TABLE, WITH DIFFERENT TRUTH SEMANTICS. Mixing them up is how a memory system
-- starts lying, so the split is explicit:
--
--   NATIVE  (truth lives HERE)  — session, request, delegation, agent_run, review_finding,
--           audit_event. These are EVENTS: appended, never revised, and they have no markdown
--           source anywhere. Losing this database loses them.
--
--   DERIVED (truth lives in GIT) — task, handoff, open_item, progress_snapshot, session_log,
--           agent_log_entry. Projections of files under version control, rebuildable from
--           scratch at any time. If they disagree with the repo, the REPO is right; delete and
--           resync. `source_file` makes staleness detectable rather than silent.
--
-- Several CHECK constraints below encode the project's working rules rather than merely typing
-- the data. That is deliberate: a rule enforced only by instructions is a rule that quietly
-- lapses, and this store exists precisely to stop unverified claims and dropped work.

create table if not exists schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now()
);

-- Self-identification: this database names the project it belongs to, so a dump is attributable
-- on its own without consulting the registry. Singleton by construction.
create table if not exists project_meta (
  singleton     boolean primary key default true check (singleton),
  project_id    uuid not null,
  slug          text not null,
  registered_at timestamptz not null default now()
);

-- ─────────────────────────────── NATIVE: the event spine ───────────────────────────────

create table if not exists session (
  session_id       uuid primary key,
  project_id       uuid not null,
  machine_hostname text,
  launch_cwd       text,
  git_branch       text,
  git_head         text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz
);

-- "What was asked" — the user's request, verbatim.
create table if not exists request (
  request_id  bigint generated always as identity primary key,
  session_id  uuid references session(session_id) on delete cascade,
  project_id  uuid not null,
  at          timestamptz not null default now(),
  asked       text not null,
  asked_tsv   tsvector generated always as (to_tsvector('english', asked)) stored
);

-- "What was tasked" — one row per delegation-plan row (SOP-07).
create table if not exists delegation (
  delegation_id bigint generated always as identity primary key,
  request_id    bigint references request(request_id) on delete set null,
  session_id    uuid   references session(session_id) on delete cascade,
  project_id    uuid not null,
  plan_phase    text,
  row_no        int,
  task          text not null,
  agent         text not null,
  model         text,
  effort        text,
  scope_will    text,
  scope_wont    text,
  acceptance    text not null,
  status        text not null default 'proposed'
                check (status in ('proposed','approved','doing','done','abandoned')),
  approved_by   text,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  -- Attribution must be complete or absent — a half-recorded approval ("someone, at some point")
  -- is worse than none, because it reads as authorised.
  --
  -- NOTE this deliberately does NOT require approval for status doing/done, even though the SOP
  -- says nothing runs unapproved. The gate is enforced at spawn time by delegation-gate.sh; this
  -- table records HISTORY, including history that predates the control. A constraint rejecting a
  -- true historical record would only pressure the backfill into inventing approvals.
  constraint delegation_approval_paired check ((approved_by is null) = (approved_at is null))
);

-- The subagent checklist. One row per spawned agent: asked -> issue -> diagnosis -> solution ->
-- resolved? -> what is missing -> next steps -> handoff.
create table if not exists agent_run (
  agent_run_id     bigint generated always as identity primary key,
  delegation_id    bigint references delegation(delegation_id) on delete set null,
  session_id       uuid   references session(session_id) on delete cascade,
  project_id       uuid not null,
  agent            text not null,
  model            text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  asked            text not null,
  issue            text,
  diagnosis        text,
  diagnosis_status text check (diagnosis_status in ('VERIFIED','ASSUMED','COULD_NOT_VERIFY')),
  solution         text,
  resolved         boolean,
  missing          text,
  next_steps       text,
  handoff_path     text,
  -- An unresolved run MUST say what is missing or what comes next. A run that ended "not done"
  -- with neither is exactly how work disappears silently between sessions — the failure this
  -- whole store exists to prevent. `resolved IS NULL` (still running) is allowed through.
  constraint agent_run_open_has_next
    check (resolved is not false or missing is not null or next_steps is not null),
  -- A stated diagnosis carries its evidence tag. An untagged mechanism is the confident-wrong-
  -- answer failure mode: verified facts and invented ones delivered in the same register.
  constraint agent_run_diagnosis_tagged
    check (diagnosis is null or diagnosis_status is not null)
);

-- The deep-review log (Ground / Verify / Break-it).
create table if not exists review_finding (
  finding_id   bigint generated always as identity primary key,
  session_id   uuid   references session(session_id) on delete cascade,
  agent_run_id bigint references agent_run(agent_run_id) on delete set null,
  project_id   uuid not null,
  claim        text not null,
  verdict      text not null check (verdict in ('VERIFIED','ASSUMED','COULD_NOT_VERIFY')),
  evidence     text,
  refuted_by   text,
  at           timestamptz not null default now(),
  -- VERIFIED means something was actually RUN or READ. Without the command or file that
  -- establishes it, the honest verdict is ASSUMED — so the database refuses the upgrade.
  constraint review_verified_needs_evidence
    check (verdict <> 'VERIFIED' or (evidence is not null and length(btrim(evidence)) > 0))
);

create table if not exists audit_event (
  audit_id     bigint generated always as identity primary key,
  session_id   uuid references session(session_id) on delete set null,
  project_id   uuid not null,
  at           timestamptz not null default now(),
  category     text not null check (category in
                 ('SCHEMA','SECURITY','DEPENDENCY','DESTRUCTIVE','EXTERNAL','EXCEPTION','DATA')),
  actor        text not null,
  what         text not null,
  why          text,
  reversible   boolean,
  verification text
);

-- ─────────────────────────── DERIVED: projections of git ───────────────────────────
-- Rebuildable. `sha256` is what makes "is this row stale?" a query rather than a guess.

create table if not exists source_file (
  path      text primary key,
  sha256    text not null,
  bytes     integer,
  synced_at timestamptz not null default now()
);

create table if not exists task (
  task_key    text primary key,          -- filename; stable across edits
  project_id  uuid not null,
  task_id     text not null,             -- the frontmatter `id:` e.g. T024
  title       text,
  status      text,
  owner       text,
  branch      text,
  acceptance  text,
  due         date,
  contracts   text,
  handoff     text,
  updated     date,
  source_path text references source_file(path) on delete cascade
);

create table if not exists handoff (
  handoff_key text primary key,
  project_id  uuid not null,
  topic       text,
  from_agent  text,
  to_agent    text,
  dated       date,
  produced    text,
  verified    text,
  unverified  text,
  body        text,
  source_path text references source_file(path) on delete cascade
);

create table if not exists open_item (
  open_item_id bigint generated always as identity primary key,
  project_id   uuid not null,
  opened_on    date,
  item         text not null,
  next_action  text,
  source_path  text references source_file(path) on delete cascade
);

-- PROGRESS.md is overwritten in place, so git holds its history but the DB keeps snapshots to
-- make "what did this project look like on date X" answerable without walking the reflog.
create table if not exists progress_snapshot (
  snapshot_id bigint generated always as identity primary key,
  project_id  uuid not null,
  captured_at timestamptz not null default now(),
  sha256      text not null,
  body        text not null
);

create table if not exists session_log (
  log_path    text primary key,
  project_id  uuid not null,
  log_date    date,
  slug        text,
  body        text not null,
  body_tsv    tsvector generated always as (to_tsvector('english', body)) stored,
  source_path text references source_file(path) on delete cascade
);

-- agent-log.md is append-only prose; entries are split on their date headings. The content hash
-- is UNIQUE so re-syncing the same file cannot duplicate entries — the exact defect that made
-- the old union-merged task table unusable.
create table if not exists agent_log_entry (
  entry_id    bigint generated always as identity primary key,
  project_id  uuid not null,
  entry_date  date,
  heading     text,
  body        text not null,
  sha256      text not null unique,
  source_path text references source_file(path) on delete cascade
);

-- ─────────────────────────────────── indexes ───────────────────────────────────

create index if not exists request_tsv_idx        on request      using gin (asked_tsv);
create index if not exists session_log_tsv_idx    on session_log  using gin (body_tsv);
create index if not exists session_started_idx    on session      (started_at desc);
create index if not exists agent_run_open_idx     on agent_run    (resolved, started_at desc);
create index if not exists delegation_status_idx  on delegation   (status, created_at desc);
create index if not exists review_verdict_idx     on review_finding (verdict, at desc);
create index if not exists audit_at_idx           on audit_event  (at desc);
create index if not exists task_status_idx        on task         (status);
create index if not exists agent_log_date_idx     on agent_log_entry (entry_date desc);
