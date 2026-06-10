// Install a desktop/menu launcher for the Creare app. Wired into `predev`, so it
// runs (idempotently) the first time someone runs `pnpm dev` on a Linux machine.
//
// - Linux only: on macOS/Windows it exits quietly (the repo syncs to a Mac via
//   Syncthing, and a Linux .desktop file is meaningless there).
// - References the committed icon at apps/desktop/resources/icon.png — no runtime
//   SVG converter needed. (resources/, not build/, because Syncthing ignores build/.)
// - Always exits 0: a launcher-install hiccup must never block `pnpm dev`.
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { homedir, platform } from 'os'

try {
  if (platform() !== 'linux') process.exit(0)

  const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
  const launcher = join(repo, 'scripts/launch-creare.sh')
  const png = join(repo, 'apps/desktop/resources/icon.png')
  const svg = join(repo, 'apps/desktop/resources/icon.svg')
  const icon = existsSync(png) ? png : svg

  // Make sure the launcher is executable (git may not preserve the bit on every machine).
  try {
    chmodSync(launcher, 0o755)
  } catch {}

  const entry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Creare
GenericName=Agentic DevOps Platform
Comment=Launch the Creare desktop app
Exec=${launcher}
Icon=${icon}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=Creare
`

  const home = homedir()
  const appsDir = join(home, '.local/share/applications')
  const appsFile = join(appsDir, 'creare.desktop')
  mkdirSync(appsDir, { recursive: true })

  // Menu entry: (re)write only when content differs, so the Exec/Icon paths stay
  // correct if the repo moves, without needless churn.
  let created = false
  if (!existsSync(appsFile)) created = true
  if (created || readFileSync(appsFile, 'utf8') !== entry) {
    writeFileSync(appsFile, entry)
    try {
      chmodSync(appsFile, 0o755)
    } catch {}
    try {
      execFileSync('update-desktop-database', [appsDir], { stdio: 'ignore' })
    } catch {}
  }

  // Desktop icon: create only if absent, so we don't reset the file manager's
  // "trusted" flag (which would re-trigger the untrusted-launcher prompt).
  let deskDir = join(home, 'Desktop')
  try {
    deskDir = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim() || deskDir
  } catch {}
  const deskFile = join(deskDir, 'creare.desktop')
  if (existsSync(deskDir) && !existsSync(deskFile)) {
    writeFileSync(deskFile, entry)
    try {
      chmodSync(deskFile, 0o755)
    } catch {}
    try {
      execFileSync('gio', ['set', deskFile, 'metadata::trusted', 'true'], { stdio: 'ignore' })
    } catch {}
    created = true
  }

  if (created) console.log('Installed Creare launcher (app menu + desktop icon)')
} catch {
  // Never block `pnpm dev` on launcher-install problems.
}
process.exit(0)
