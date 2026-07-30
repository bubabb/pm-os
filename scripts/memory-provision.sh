#!/usr/bin/env bash
# Provision a project's memory database. Idempotent: re-running is a no-op, never a duplicate.
#
#   memory-provision.sh --global            create/upgrade memory_global (the registry)
#   memory-provision.sh --project           create/upgrade THIS project's database + role, register it
#   memory-provision.sh --status            report what exists, change nothing
#   memory-provision.sh --deprovision SLUG  drop a project's database + role (asks first)
#
# CREDENTIALS: ~/.config/agent-memory/admin.env (override with MEMORY_ADMIN_ENV). Per-project role
# passwords are written to ~/.config/agent-memory/projects/<slug>.env, NOT into the repo — $HOME is
# a git repo with no .gitignore, so a secret inside a project directory is one `git add -A` from
# being committed. Keeping them under ~/.config with one git exclude is the smaller attack surface.
#
# ADMIN CONNECTION uses the pooler's SESSION port (5432), not the transaction port (6543):
# CREATE DATABASE cannot run inside a transaction block, which is what 6543 forces. Falls back to
# the direct IPv6 endpoint if the pooler is unreachable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # this script's project — never CLAUDE_PROJECT_DIR
ADMIN_ENV="${MEMORY_ADMIN_ENV:-$HOME/.config/agent-memory/admin.env}"
SECRET_DIR="$(dirname "$ADMIN_ENV")/projects"
MIG_DIR="$ROOT/memory/migrations"

die() { echo "memory-provision: $*" >&2; exit 1; }
note() { echo "  $*" >&2; }

[ -r "$ADMIN_ENV" ] || die "no credentials at $ADMIN_ENV"
# shellcheck disable=SC1090
set -a; . "$ADMIN_ENV"; set +a
[ -n "${MEMORY_PROJECT_REF:-}" ] || die "admin.env has no MEMORY_PROJECT_REF"
[ -n "${MEMORY_DB_PASSWORD:-}" ] || die "admin.env has no MEMORY_DB_PASSWORD"
POOLER="${MEMORY_POOLER_HOST:?missing MEMORY_POOLER_HOST}"
ADMIN_PORT="${MEMORY_ADMIN_PORT:-5432}"
POOL_PORT="${MEMORY_POOL_PORT:-6543}"

# Resolve the admin route once. Preferring the pooler keeps provisioning working from machines
# without IPv6; the direct endpoint is the fallback because it is IPv6-only (verified 2026-07-30).
ADMIN_KIND=""
admin_conn() { # $1 = dbname
  case "$ADMIN_KIND" in
    pooler) printf 'host=%s port=%s dbname=%s user=postgres.%s sslmode=require' "$POOLER" "$ADMIN_PORT" "$1" "$MEMORY_PROJECT_REF" ;;
    direct) printf 'host=db.%s.supabase.co port=5432 dbname=%s user=postgres sslmode=require' "$MEMORY_PROJECT_REF" "$1" ;;
    *) die "admin route not resolved" ;;
  esac
}
resolve_admin() {
  export PGPASSWORD="$MEMORY_DB_PASSWORD"
  ADMIN_KIND=pooler
  if psql "$(admin_conn postgres)" -tAc 'select 1' >/dev/null 2>&1; then note "admin route: pooler session ($POOLER:$ADMIN_PORT)"; return; fi
  ADMIN_KIND=direct
  if psql "$(admin_conn postgres)" -tAc 'select 1' >/dev/null 2>&1; then note "admin route: direct IPv6 (db.$MEMORY_PROJECT_REF.supabase.co)"; return; fi
  die "cannot reach the memory instance on either route — is it paused, or is the password wrong?"
}
psq() { local db="$1"; shift; psql -v ON_ERROR_STOP=1 "$(admin_conn "$db")" "$@"; }

# `-` is legal in a slug and in a folder name, but not in an unquoted Postgres identifier.
dbname_for()   { printf 'memory_%s' "$(printf '%s' "$1" | tr '-' '_')"; }
rolename_for() { printf 'mem_%s'    "$(printf '%s' "$1" | tr '-' '_')"; }

db_exists()   { [ "$(psq postgres -tAc "select 1 from pg_database where datname='$1'")" = 1 ]; }
role_exists() { [ "$(psq postgres -tAc "select 1 from pg_roles where rolname='$1'")" = 1 ]; }

# Apply every *.sql in a directory in filename order, once. `schema_migrations` is the ledger;
# each file runs in a single transaction so a partial file can never be recorded as applied.
apply_migrations() { # $1=dbname  $2=migration subdir
  local db="$1" dir="$MIG_DIR/$2" f version
  [ -d "$dir" ] || die "no migration dir $dir"
  psq "$db" -qc "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now());" >/dev/null
  for f in "$dir"/*.sql; do
    [ -e "$f" ] || continue
    version="$(basename "$f")"
    if [ "$(psq "$db" -tAc "select 1 from schema_migrations where version='$version'")" = 1 ]; then
      note "  $db: $version already applied"; continue
    fi
    note "  $db: applying $version"
    psq "$db" -q --single-transaction -f "$f" >/dev/null
    psq "$db" -qc "insert into schema_migrations(version) values ('$version');" >/dev/null
  done
}

ensure_global() {
  if db_exists memory_global; then note "memory_global exists"; else
    note "creating memory_global"; psq postgres -qc "CREATE DATABASE memory_global;" >/dev/null
  fi
  # The registry holds every project's location. Nothing but the admin role needs to read it.
  psq postgres -qc "REVOKE CONNECT ON DATABASE memory_global FROM PUBLIC;" >/dev/null 2>&1 || true
  apply_migrations memory_global global
}

provision_project() {
  local idfile="$ROOT/.project-id"
  [ -r "$idfile" ] || die "no .project-id in $ROOT — run scripts/project-id.sh --ensure first"
  local pid slug db role pw cred_path
  pid="$(sed -n 's/^project_id=//p' "$idfile" | head -1)"
  slug="$(sed -n 's/^slug=//p' "$idfile" | head -1)"
  [ -n "$pid" ] && [ -n "$slug" ] || die "malformed .project-id"
  db="$(dbname_for "$slug")"; role="$(rolename_for "$slug")"
  cred_path="$SECRET_DIR/$slug.env"
  note "project $slug ($pid) -> database $db, role $role"

  ensure_global

  # A DIFFERENT project already registered under this id means a copied .project-id — the exact
  # collision `make init --regenerate` exists to prevent. Refuse loudly; do not "fix" it silently.
  local claimed; claimed="$(psq memory_global -tAc "select slug from project where project_id='$pid'")"
  [ -n "$claimed" ] && [ "$claimed" != "$slug" ] && \
    die "project_id $pid is already registered to '$claimed'. This repo's .project-id was copied. Run scripts/project-id.sh --regenerate, then retry."

  mkdir -p "$SECRET_DIR"; chmod 700 "$SECRET_DIR"
  if role_exists "$role"; then
    note "role $role exists"
    [ -r "$cred_path" ] || note "WARNING: role exists but $cred_path is missing — the password is unrecoverable; use --deprovision then re-provision to reset it"
  else
    pw="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    note "creating role $role"
    psq postgres -qc "CREATE ROLE \"$role\" LOGIN PASSWORD '$pw';" >/dev/null
    umask 077; printf '# %s memory database credentials. Generated %s. Do NOT commit.\nMEMORY_DSN=postgresql://%s.%s:%s@%s:%s/%s\nMEMORY_ROLE=%s\nMEMORY_DB=%s\nPROJECT_ID=%s\n' \
      "$slug" "$(date -u +%F)" "$role" "$MEMORY_PROJECT_REF" "$pw" "$POOLER" "$POOL_PORT" "$db" "$role" "$db" "$pid" > "$cred_path"
    chmod 600 "$cred_path"; note "credentials -> $cred_path"
  fi

  # The admin role on Supabase is NOT a superuser (rolsuper=f, measured 2026-07-30), so it cannot
  # hand a database to a role it is not a member of: CREATE DATABASE ... OWNER fails with
  # `must be able to SET ROLE "<role>"`. Granting membership first is what makes ownership legal.
  psq postgres -qc "GRANT \"$role\" TO CURRENT_USER;" >/dev/null 2>&1 || true

  if db_exists "$db"; then note "database $db exists"; else
    note "creating database $db"; psq postgres -qc "CREATE DATABASE \"$db\" OWNER \"$role\";" >/dev/null
  fi

  # ISOLATION — this is spec (d) enforced by the server, not by convention. PUBLIC loses CONNECT,
  # so mem_<other> cannot reach this database even holding valid credentials.
  psq postgres -qc "REVOKE CONNECT ON DATABASE \"$db\" FROM PUBLIC;" >/dev/null 2>&1 || true
  psq postgres -qc "GRANT CONNECT ON DATABASE \"$db\" TO \"$role\";" >/dev/null

  apply_migrations "$db" project

  # Tables are created by the admin role; hand ownership of the working set to the project role.
  psq "$db" -qc "GRANT USAGE, CREATE ON SCHEMA public TO \"$role\";
                 GRANT ALL ON ALL TABLES IN SCHEMA public TO \"$role\";
                 GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO \"$role\";
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$role\";
                 ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$role\";" >/dev/null

  psq "$db" -qc "insert into project_meta (singleton, project_id, slug) values (true,'$pid','$slug')
                 on conflict (singleton) do update set project_id=excluded.project_id, slug=excluded.slug;" >/dev/null

  local remote path; remote="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"; path="$ROOT"
  psq memory_global -qc "insert into project (project_id, slug, name, db_name, role_name, git_remote, repo_path)
       values ('$pid','$slug','$slug','$db','$role', nullif('$remote',''), '$path')
       on conflict (project_id) do update set slug=excluded.slug, db_name=excluded.db_name,
         role_name=excluded.role_name, git_remote=excluded.git_remote, repo_path=excluded.repo_path;" >/dev/null
  note "registered in memory_global.project"
}

status() {
  echo "instance: $MEMORY_PROJECT_REF ($ADMIN_KIND)"
  echo "databases:"; psq postgres -tAc "select '  '||datname from pg_database where datname like 'memory%' order by 1"
  echo "roles:";     psq postgres -tAc "select '  '||rolname from pg_roles where rolname like 'mem\\_%' order by 1"
  if db_exists memory_global; then
    echo "registry:"; psq memory_global -tAc "select '  '||slug||'  '||project_id||'  '||db_name from project order by slug"
  else echo "registry: memory_global does not exist"; fi
}

deprovision() { # $1 = slug
  local slug="$1" db role; db="$(dbname_for "$slug")"; role="$(rolename_for "$slug")"
  printf 'DROP database %s and role %s? This destroys that project'"'"'s memory permanently. [y/N] ' "$db" "$role" >&2
  read -r a; case "$a" in y|Y) ;; *) die "aborted";; esac
  # WITH (FORCE) is REQUIRED, not defensive: Supavisor keeps backends warm after the client
  # disconnects, so a plain DROP fails with "is being accessed by other users" (verified 2026-07-30)
  # and a half-provisioned project could not otherwise be cleaned up.
  psq postgres -qc "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);" >/dev/null
  psq postgres -qc "DROP ROLE IF EXISTS \"$role\";" >/dev/null
  psq memory_global -qc "delete from project where slug='$slug';" >/dev/null 2>&1 || true
  rm -f "$SECRET_DIR/$slug.env"
  note "deprovisioned $slug"
}

case "${1:---project}" in
  --global)      resolve_admin; ensure_global ;;
  --project)     resolve_admin; provision_project ;;
  --status)      resolve_admin; status ;;
  --deprovision) [ -n "${2:-}" ] || die "usage: --deprovision SLUG"; resolve_admin; deprovision "$2" ;;
  *) die "usage: memory-provision.sh [--global|--project|--status|--deprovision SLUG]" ;;
esac
