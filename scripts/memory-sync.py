#!/usr/bin/env python3
"""Sync this project's markdown records into its memory database, and flush the event spool.

TRUTH DIRECTION, WHICH IS THE WHOLE DESIGN: git is authoritative for everything this script reads.
The rows it writes are a PROJECTION — rebuildable from the files at any time. If a row and a file
disagree, the file is right; delete the row and resync. Nothing here ever writes back to markdown.

WHY CONTENT HASHES: a mirror that can silently drift is worse than no mirror, because it answers
queries confidently with stale data. Every synced file's sha256 is stored in `source_file`, so
"is the database current?" is one query rather than a belief. An unchanged file costs nothing —
it is skipped before it is even parsed.

WHY psql AND NOT A DRIVER: no psycopg/psycopg2/asyncpg is installed on this machine (checked), and
requiring one would make memory sync fail on any machine that opens the project. Parsing happens
here; transport is a generated SQL script piped to psql, using COPY ... FROM stdin in CSV so that
arbitrary markdown — quotes, newlines, backslashes — round-trips without hand-rolled escaping.

Usage:
    memory-sync.py            sync changed files + flush the spool
    memory-sync.py --check    report what WOULD change; write nothing (exit 1 if drift)
    memory-sync.py --force    resync every file even if its hash matches
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # <project>/scripts/.. — never CLAUDE_PROJECT_DIR
SPOOL = ROOT / ".memory-spool.jsonl"


def die(msg: str) -> None:
    print(f"memory-sync: {msg}", file=sys.stderr)
    raise SystemExit(2)


def project_identity() -> tuple[str, str]:
    f = ROOT / ".project-id"
    if not f.is_file():
        die("no .project-id — run scripts/project-id.sh --ensure")
    fields = dict(
        line.split("=", 1)
        for line in f.read_text().splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )
    pid, slug = fields.get("project_id", "").strip(), fields.get("slug", "").strip()
    if not pid or not slug:
        die("malformed .project-id")
    return pid, slug


def dsn(slug: str) -> str:
    env = Path(os.environ.get("MEMORY_ADMIN_ENV", Path.home() / ".config/agent-memory/admin.env"))
    cred_path = env.parent / "projects" / f"{slug}.env"
    if not cred_path.is_file():
        die(f"no credentials at {cred_path} — run scripts/memory-provision.sh --project")
    for line in cred_path.read_text().splitlines():
        if line.startswith("MEMORY_DSN="):
            return line.split("=", 1)[1].strip()
    die(f"no MEMORY_DSN in {cred_path}")
    return ""


def psql(dsn_: str, sql: str, quiet: bool = True) -> str:
    """Run SQL and return stdout. Errors are fatal — a partial sync must never look successful."""
    cmd = ["psql", "-v", "ON_ERROR_STOP=1", "-tA", dsn_, "-f", "-"]
    p = subprocess.run(cmd, input=sql, capture_output=True, text=True)
    if p.returncode != 0:
        err = (p.stderr or "").strip().splitlines()
        die("psql failed: " + (err[-1] if err else f"exit {p.returncode}"))
    if not quiet and p.stderr.strip():
        print(p.stderr.strip(), file=sys.stderr)
    return p.stdout


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha_text(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


# ───────────────────────────── parsers (markdown -> rows) ─────────────────────────────

FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)


def frontmatter(text: str) -> dict[str, str]:
    """Parse a closed '--- ... ---' block. An UNCLOSED block yields {} rather than swallowing the
    body up to a later horizontal rule — the same failure lint-records.sh guards against."""
    m = FM_RE.match(text)
    if not m:
        return {}
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        v = re.sub(r"\s+#.*$", "", v)          # YAML comment needs whitespace before '#'
        v = v.strip().strip('"').strip("'")     # frontmatter quotes values like "-"
        out[k.strip()] = v
    return out


def as_date(v: str | None):
    """'-' and '' are the project's explicit 'no date', not a parse failure."""
    if not v or v in {"-", "none", "None"}:
        return None
    return v if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v) else None


def parse_tasks(pid: str):
    d = ROOT / "agent-state" / "tasks"
    for f in sorted(d.glob("*.md")) if d.is_dir() else []:
        if f.name in {"_TEMPLATE.md", "README.md"}:
            continue
        fm = frontmatter(f.read_text(errors="replace"))
        if not fm.get("id"):
            continue
        rel = str(f.relative_to(ROOT))
        yield rel, "task", [
            f.name, pid, fm.get("id", ""), fm.get("title", ""), fm.get("status", ""),
            fm.get("owner", ""), fm.get("branch", ""), fm.get("acceptance", ""),
            as_date(fm.get("due")), fm.get("contracts", ""), fm.get("handoff", ""),
            as_date(fm.get("updated")), rel,
        ]


HANDOFF_META = re.compile(
    r"\*\*From\s*\(agent ID\)\s*:\*\*\s*(?P<frm>.*?)\s{2,}\*\*To:\*\*\s*(?P<to>.*?)\s{2,}\*\*Date:\*\*\s*(?P<date>[\d-]+)",
    re.S)


def section(text: str, *names: str) -> str:
    """Return the body under the first '## <name>' heading, up to the next heading of any level."""
    for n in names:
        m = re.search(rf"^#{{1,6}}\s*{n}[^\n]*\n(.*?)(?=^#{{1,6}}\s|\Z)", text, re.S | re.M | re.I)
        if m:
            return m.group(1).strip()
    return ""


def parse_handoffs(pid: str):
    d = ROOT / "agent-state" / "handoffs"
    for f in sorted(d.glob("*-output.md")) if d.is_dir() else []:
        text = f.read_text(errors="replace")
        rel = str(f.relative_to(ROOT))
        title = re.search(r"^#\s*Handoff\s*[—-]\s*(.+)$", text, re.M)
        meta = HANDOFF_META.search(text)
        ver = section(text, "Verified / unverified", "Verified")
        yield rel, "handoff", [
            f.name, pid, title.group(1).strip() if title else f.stem,
            meta.group("frm").strip() if meta else "", meta.group("to").strip() if meta else "",
            as_date(meta.group("date")) if meta else None,
            section(text, "Produced"), ver, section(text, "Unverified"), text, rel,
        ]


OPEN_ITEM = re.compile(r"^\s*[-*+]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$")


def parse_open(pid: str):
    f = ROOT / "OPEN.md"
    if not f.is_file():
        return
    rel = str(f.relative_to(ROOT))
    text = f.read_text(errors="replace")
    for raw in text.splitlines():
        m = OPEN_ITEM.match(raw)
        if not m:
            continue
        body = m.group(2).strip()
        # The ledger's convention is "<what is open> → <the exact next action>".
        nxt = ""
        for arrow in ("→", "->", "⇢"):
            if arrow in body:
                body, nxt = (p.strip() for p in body.split(arrow, 1))
                break
        yield rel, "open_item", [pid, m.group(1), body, nxt, rel]


def parse_session_logs(pid: str):
    d = ROOT / "docs" / "sessions"
    for f in sorted(d.glob("*.md")) if d.is_dir() else []:
        rel = str(f.relative_to(ROOT))
        m = re.match(r"session-(\d{4}-\d{2}-\d{2})-(.+)\.md$", f.name)
        yield rel, "session_log", [
            rel, pid, m.group(1) if m else None, m.group(2) if m else f.stem,
            f.read_text(errors="replace"), rel,
        ]


# The optional '(...)' group is not decoration: scout's log carries 13 entries headed
# '## 2026-07-26 (evening) — ...' — several per day, distinguished only by that qualifier.
# Requiring the dash immediately after the date silently dropped every one of them, which is
# exactly the kind of miss a self-authored fixture cannot reveal. The qualifier is kept in the
# heading so no information is lost.
LOG_HEAD = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})\s*(\([^)]*\))?\s*[—-]\s*(.+)$", re.M)


def parse_agent_log(pid: str):
    f = ROOT / "agent-state" / "agent-log.md"
    if not f.is_file():
        return
    rel = str(f.relative_to(ROOT))
    text = f.read_text(errors="replace")
    marks = list(LOG_HEAD.finditer(text))
    for i, m in enumerate(marks):
        body = text[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip()
        heading = f"{m.group(2) or ''} {m.group(3)}".strip()
        # Hash covers date+heading+body: the UNIQUE index on it is what makes re-syncing an
        # append-only log idempotent instead of duplicating every past entry.
        yield rel, "agent_log_entry", [
            pid, m.group(1), heading, body,
            sha_text(f"{m.group(1)}|{heading}|{body}"), rel,
        ]


COLUMNS = {
    "task": "task_key,project_id,task_id,title,status,owner,branch,acceptance,due,contracts,handoff,updated,source_path",
    "handoff": "handoff_key,project_id,topic,from_agent,to_agent,dated,produced,verified,unverified,body,source_path",
    "open_item": "project_id,opened_on,item,next_action,source_path",
    "session_log": "log_path,project_id,log_date,slug,body,source_path",
    "agent_log_entry": "project_id,entry_date,heading,body,sha256,source_path",
}
PARSERS = (parse_tasks, parse_handoffs, parse_open, parse_session_logs, parse_agent_log)


def tracked_files() -> list[Path]:
    out: list[Path] = []
    for pat in ("agent-state/tasks/*.md", "agent-state/handoffs/*-output.md",
                "docs/sessions/*.md"):
        out += [p for p in ROOT.glob(pat) if p.name not in {"_TEMPLATE.md", "README.md"}]
    for name in ("OPEN.md", "agent-state/agent-log.md"):
        p = ROOT / name
        if p.is_file():
            out.append(p)
    return sorted(out)


def csv_line(row: list) -> str:
    buf = io.StringIO()
    csv.writer(buf, lineterminator="").writerow(["" if v is None else str(v) for v in row])
    return buf.getvalue()


# ───────────────────────────────── spool (native events) ─────────────────────────────────

SPOOL_TABLES = {"session", "request", "delegation", "agent_run", "review_finding", "audit_event"}


def flush_spool_sql() -> tuple[str, int]:
    """The spool is append-only JSONL written by hooks — a filesystem write that cannot block or
    fail on a bad network. Each line is {"table": ..., "row": {...}}. Rows are inserted with
    ON CONFLICT DO NOTHING so a re-flush after a crash cannot duplicate events."""
    if not SPOOL.is_file() or SPOOL.stat().st_size == 0:
        return "", 0
    parts, n = [], 0
    for line in SPOOL.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            table, row = rec["table"], rec["row"]
        except Exception:
            continue                      # a corrupt line must not stall every later event
        if table not in SPOOL_TABLES or not isinstance(row, dict) or not row:
            continue
        cols = ",".join(row)
        vals = ",".join("NULL" if v is None else "'" + str(v).replace("'", "''") + "'"
                        for v in row.values())
        parts.append(f"INSERT INTO {table} ({cols}) VALUES ({vals}) ON CONFLICT DO NOTHING;")
        n += 1
    return "\n".join(parts), n


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    check, force = mode == "--check", mode == "--force"
    pid, slug = project_identity()
    d = dsn(slug)

    known = {}
    for line in psql(d, "select path||'\t'||sha256 from source_file;").splitlines():
        if "\t" in line:
            p, h = line.split("\t", 1)
            known[p] = h

    files = tracked_files()
    changed = [f for f in files
               if force or known.get(str(f.relative_to(ROOT))) != sha256(f)]
    gone = [p for p in known if not (ROOT / p).is_file()]

    prog = ROOT / "PROGRESS.md"
    prog_sha = sha256(prog) if prog.is_file() else None
    prog_seen = psql(d, "select sha256 from progress_snapshot order by captured_at desc limit 1;").strip()
    prog_new = bool(prog_sha and prog_sha != prog_seen)

    _, spool_n = flush_spool_sql()

    if check:
        print(f"tracked={len(files)} changed={len(changed)} removed={len(gone)} "
              f"progress_new={prog_new} spooled_events={spool_n}")
        for f in changed[:20]:
            print(f"  changed: {f.relative_to(ROOT)}")
        for p in gone[:20]:
            print(f"  removed: {p}")
        return 1 if (changed or gone or prog_new or spool_n) else 0

    sql = ["BEGIN;"]
    # Deleting the source_file row CASCADEs to every row derived from it, so a re-parse replaces
    # rather than accumulates. This is why the derived tables need no merge logic at all.
    for p in gone:
        sql.append(f"DELETE FROM source_file WHERE path = '{p}';")
    for f in changed:
        rel = str(f.relative_to(ROOT))
        sql.append(f"DELETE FROM source_file WHERE path = '{rel}';")
        sql.append(f"INSERT INTO source_file (path, sha256, bytes) VALUES "
                   f"('{rel}', '{sha256(f)}', {f.stat().st_size});")

    changed_rel = {str(f.relative_to(ROOT)) for f in changed}
    buckets: dict[str, list[str]] = {}
    for parser in PARSERS:
        for rel, table, row in parser(pid):
            if rel in changed_rel:
                buckets.setdefault(table, []).append(csv_line(row))
    for table, lines in buckets.items():
        sql.append(f"COPY {table} ({COLUMNS[table]}) FROM stdin WITH (FORMAT csv);")
        sql.extend(lines)
        sql.append("\\.")

    if prog_new:
        body = prog.read_text(errors="replace")
        sql.append("COPY progress_snapshot (project_id, sha256, body) FROM stdin WITH (FORMAT csv);")
        sql.append(csv_line([pid, prog_sha, body]))
        sql.append("\\.")

    spool_sql, _ = flush_spool_sql()
    if spool_sql:
        sql.append(spool_sql)
    sql.append("COMMIT;")

    psql(d, "\n".join(sql))
    if spool_n:
        SPOOL.unlink(missing_ok=True)     # only after COMMIT — a failed sync must keep the spool

    counts = psql(d, "select 'tasks='||(select count(*) from task)||' handoffs='||"
                     "(select count(*) from handoff)||' open='||(select count(*) from open_item)||"
                     "' logs='||(select count(*) from session_log)||' entries='||"
                     "(select count(*) from agent_log_entry);").strip()
    print(f"memory-sync: {len(changed)} file(s) synced, {len(gone)} removed, "
          f"{spool_n} event(s) flushed | {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
