-- memory_global 001 — the project registry and work tied to no project.
--
-- This database answers two questions the per-project databases cannot:
--   1. "which projects exist, and which database holds each one's memory?"  -> project
--   2. "what happened in a session that wasn't about any project?"          -> global_session/event
--
-- It deliberately holds NO project work. Cross-project questions start here (read the registry),
-- then fan out to the named databases — isolation is the requirement, so there is no shared table
-- that every project writes into.

create table if not exists schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now()
);

create table if not exists machine (
  machine_id  uuid primary key default gen_random_uuid(),
  hostname    text unique not null,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

-- The registry. `project_id` is the id in <repo>/.project-id.
--
-- THE PRIMARY KEY IS THE SECOND GUARD AGAINST A COPIED IDENTITY. A new project is born as
-- `cp -R _template <slug>`, which copies .project-id too; `make init` regenerates it, but a copy
-- that skips init would arrive here carrying the template's id. Inserting it then violates this
-- PK and fails LOUDLY, instead of two repos silently sharing one memory identity — which is
-- unrecoverable once rows exist under it.
create table if not exists project (
  project_id  uuid        primary key,
  slug        text        unique not null,
  name        text        not null,
  db_name     text        unique not null,
  role_name   text        unique not null,
  git_remote  text,
  repo_path   text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  -- The slug becomes part of a database name and a role name. Postgres truncates identifiers at
  -- 63 bytes, so an over-long slug would silently collide with another after truncation; and a
  -- character outside this set would need quoting everywhere it is interpolated.
  constraint project_slug_shape check (slug ~ '^[a-z0-9][a-z0-9_-]{0,39}$')
);

-- Spec (a): sessions launched outside any project. Per the Step 0.1 finding, a session launched
-- from $HOME resolves to no project — so the launch directory is what routes work here rather
-- than into a project database.
create table if not exists global_session (
  session_id  uuid primary key,
  machine_id  uuid references machine(machine_id),
  launch_cwd  text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  summary     text
);

create table if not exists global_event (
  event_id    bigint generated always as identity primary key,
  session_id  uuid references global_session(session_id) on delete cascade,
  at          timestamptz not null default now(),
  kind        text not null check (kind in ('request','note','decision','handoff')),
  body        text not null,
  body_tsv    tsvector generated always as (to_tsvector('english', body)) stored
);

create index if not exists global_event_tsv_idx  on global_event using gin (body_tsv);
create index if not exists global_event_at_idx   on global_event (at desc);
create index if not exists project_active_idx    on project (slug) where archived_at is null;
