#!/usr/bin/env python3
"""Emit this project's memory as a context block for the SessionStart hook.

WHAT THIS ADDS OVER THE FILE-BASED RESUME: the existing hook injects the top of PROGRESS.md and all
of OPEN.md — a fixed slice of two files. This answers questions no file can: which delegated tasks
were never closed, which agent runs ended unresolved and what they said was missing, which findings
are still ASSUMED rather than VERIFIED, and what other projects exist. Those live only in the
database because they have no markdown home.

FAILURE DIRECTION — THE POINT OF THIS SCRIPT'S DESIGN: if the database is unreachable it prints a
LOUD banner saying so and exits 0. It never fails the session, and it never returns silence that
could be mistaken for "nothing is open". A missing store and an empty store must not look alike;
that confusion is precisely how a session resumes believing there is no outstanding work.

Usage:
    memory-recall.py            human/markdown block on stdout
    memory-recall.py --json     {"context": "..."} for a hook's additionalContext
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # this script's project — never CLAUDE_PROJECT_DIR
TIMEOUT = int(os.environ.get("MEMORY_RECALL_TIMEOUT", "8"))   # a session start must not hang
LIMIT = 6                                                     # keep the block small; it is injected every session


def identity() -> tuple[str, str] | None:
    f = ROOT / ".project-id"
    if not f.is_file():
        return None
    d = dict(l.split("=", 1) for l in f.read_text().splitlines()
             if "=" in l and not l.lstrip().startswith("#"))
    pid, slug = d.get("project_id", "").strip(), d.get("slug", "").strip()
    return (pid, slug) if pid and slug else None


def dsn(slug: str) -> str | None:
    env = Path(os.environ.get("MEMORY_ADMIN_ENV", Path.home() / ".config/agent-memory/admin.env"))
    secret = env.parent / "projects" / f"{slug}.env"
    if not secret.is_file():
        return None
    for line in secret.read_text().splitlines():
        if line.startswith("MEMORY_DSN="):
            return line.split("=", 1)[1].strip()
    return None


def query(dsn_: str, sql: str) -> list[list[str]] | None:
    """Returns None on ANY failure — unreachable, timeout, bad credentials. The caller turns that
    into the loud banner. Distinguishing failure (None) from emptiness ([]) is the whole contract."""
    try:
        p = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-tAF\x1f", dsn_, "-c", sql],
                           capture_output=True, text=True, timeout=TIMEOUT)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    if p.returncode != 0:
        return None
    return [ln.split("\x1f") for ln in p.stdout.strip().splitlines() if ln.strip()]


def main() -> int:
    as_json = "--json" in sys.argv
    ident = identity()
    out: list[str] = []

    def emit(s: str = "") -> None:
        out.append(s)

    if ident is None:
        block = ("## Memory\n\n**This project has no `.project-id`** — it is not registered, so no "
                 "memory database is being read or written. Run `scripts/project-id.sh --ensure` "
                 "then `scripts/memory-provision.sh --project`.")
        print(json.dumps({"context": block}) if as_json else block)
        return 0

    pid, slug = ident
    d = dsn(slug)
    if d is None:
        block = (f"## Memory — {slug}\n\n**⚠ NO CREDENTIALS FOUND** for this project "
                 f"(`~/.config/agent-memory/projects/{slug}.env` is missing). Memory is NOT being "
                 f"read this session — treat the file-based resume above as the only record. "
                 f"Run `scripts/memory-provision.sh --project` to restore it.")
        print(json.dumps({"context": block}) if as_json else block)
        return 0

    probe = query(d, "select 1")
    if probe is None:
        block = (f"## Memory — {slug}\n\n"
                 f"**⚠ MEMORY DATABASE UNREACHABLE.** This session is running on FILES ONLY.\n\n"
                 f"Anything below this line came from `PROGRESS.md`/`OPEN.md`, not from the "
                 f"database — so open delegations, unresolved agent runs and unverified findings "
                 f"are **not** shown and must not be assumed absent. The instance may be paused, "
                 f"the network down, or the credentials stale. Check with "
                 f"`scripts/memory-provision.sh --status`.")
        print(json.dumps({"context": block}) if as_json else block)
        return 0

    emit(f"## Memory — {slug}")
    emit()

    # ONE round trip, not six. Each psql invocation pays a TLS handshake to the pooler, which
    # measured ~500ms — six of them put ~3s on every session start for data that fits in a single
    # query. Sections are tagged and ordered, then split here.
    # Two real columns, joined by psql's field separator (\x1f) — NOT a separator embedded in one
    # column. Python's str.splitlines() treats \x1c, \x1d and \x1e as LINE boundaries, so tagging
    # rows with \x1e silently tore every one in half inside query(). \x1f is not in that set.
    rows = query(d, f"""
      select sec, line from (
        select 1 as ord, 'counts' as sec,
               'Indexed: ' || (select count(*) from task) || ' tasks · ' ||
               (select count(*) from handoff) || ' handoffs · ' ||
               (select count(*) from agent_log_entry) || ' log entries · ' ||
               (select count(*) from session_log) || ' session logs (last sync ' ||
               coalesce((select max(synced_at)::date::text from source_file), 'never') || ').' as line
        union all
        select 2, 'unresolved', line from (
          select '- `' || agent || '` (' || started_at::date || '): ' ||
                 left(coalesce(nullif(missing,''), next_steps, '(no next step recorded)'), 160) as line
          from agent_run where resolved is false order by started_at desc limit {LIMIT}) a
        union all
        select 3, 'delegation', line from (
          select '- [' || status || '] ' || left(task,120) || ' → `' || agent || '`' as line
          from delegation where status in ('proposed','approved','doing')
          order by created_at desc limit {LIMIT}) b
        union all
        select 4, 'unverified', line from (
          select '- ' || verdict || ': ' || left(claim,160) as line
          from review_finding where verdict in ('ASSUMED','COULD_NOT_VERIFY')
          order by at desc limit {LIMIT}) c
        union all
        select 5, 'irreversible', line from (
          select '- ' || at::date || ' [' || category || '] ' || left(what,120) as line
          from audit_event where reversible is false order by at desc limit 3) e
        union all
        select 6, 'stale', 'x' from source_file
          where synced_at < now() - interval '7 days' having count(*) > 0
      ) z order by ord""")

    grouped: dict[str, list[str]] = {}
    for r in rows or []:
        if len(r) >= 2:
            grouped.setdefault(r[0], []).append(r[1])

    for line in grouped.get("counts", []):
        emit(line)
        emit()

    # ── the boxes from the design that have no markdown equivalent ──
    for key, header in (
        ("unresolved",   "**Agent runs that ended UNRESOLVED — what was missing:**"),
        ("delegation",   "**Delegations not closed:**"),
        ("unverified",   "**Findings still unverified — do not restate these as fact:**"),
        ("irreversible", "**Irreversible actions on record:**"),
    ):
        if grouped.get(key):
            emit(header)
            for line in grouped[key]:
                emit(line)
            emit()

    if grouped.get("stale"):
        emit(f"_{len(grouped['stale'])} indexed file(s) not re-synced in over 7 days — "
             f"run `make memory-sync` if the repo has moved on._")
        emit()

    # Cross-project awareness. Deliberately names ONLY the other projects: their memory lives in
    # separate databases this role cannot reach, which is the isolation working as specified.
    admin = Path(os.environ.get("MEMORY_ADMIN_ENV", Path.home() / ".config/agent-memory/admin.env"))
    if admin.is_file():
        kv = dict(l.split("=", 1) for l in admin.read_text().splitlines()
                  if "=" in l and not l.lstrip().startswith("#"))
        ref, pw = kv.get("MEMORY_PROJECT_REF", "").strip(), kv.get("MEMORY_DB_PASSWORD", "").strip()
        host, port = kv.get("MEMORY_POOLER_HOST", "").strip(), kv.get("MEMORY_POOL_PORT", "6543").strip()
        if ref and pw and host:
            g = query(f"postgresql://postgres.{ref}:{pw}@{host}:{port}/memory_global",
                      f"select slug from project where project_id <> '{pid}' "
                      f"and archived_at is null order by slug")
            if g:
                emit("Other registered projects: " + ", ".join(r[0] for r in g)
                     + " — their memory is in separate databases (not readable from here).")
                emit()

    block = "\n".join(out).rstrip()
    print(json.dumps({"context": block}) if as_json else block)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
