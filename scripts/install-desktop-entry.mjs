// Install a desktop/menu launcher for the Pm.Os app. Wired into `predev`, so it
// runs (idempotently) the first time someone runs `pnpm dev` on a machine.
//
// - Linux: installs a .desktop entry (app menu + desktop icon).
// - macOS: installs a minimal ~/Applications/Pm.Os.app bundle (the repo syncs to
//   a Mac via Syncthing, where a Linux .desktop file is meaningless). Double-click
//   launches scripts/launch-pm-os.sh with no terminal.
// - Other platforms: exits quietly.
// - References the committed icon at apps/desktop/resources/icon.png — no runtime
//   SVG converter needed. (resources/, not build/, because Syncthing ignores build/.)
// - Always exits 0: a launcher-install hiccup must never block `pnpm dev`.
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { homedir, platform, tmpdir } from 'os'

try {
  const plat = platform()
  if (plat !== 'linux' && plat !== 'darwin') process.exit(0)

  const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
  const launcher = join(repo, 'scripts/launch-pm-os.sh')
  const png = join(repo, 'apps/desktop/resources/icon.png')
  const svg = join(repo, 'apps/desktop/resources/icon.svg')
  const icon = existsSync(png) ? png : svg
  const home = homedir()

  // Make sure the launcher is executable (git may not preserve the bit on every machine).
  try {
    chmodSync(launcher, 0o755)
  } catch {}

  // (Re)write a file only when its content differs — keeps paths current if the
  // repo moves, without needless churn. Returns true if it wrote.
  const writeIfChanged = (file, content, mode) => {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
    writeFileSync(file, content)
    if (mode !== undefined) {
      try {
        chmodSync(file, mode)
      } catch {}
    }
    return true
  }

  if (plat === 'linux') {
    const entry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Pm.Os
GenericName=Agentic DevOps Platform
Comment=Launch the Pm.Os desktop app
Exec=${launcher}
Icon=${icon}
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=Pm.Os
`

    const appsDir = join(home, '.local/share/applications')
    const appsFile = join(appsDir, 'pm-os.desktop')
    mkdirSync(appsDir, { recursive: true })

    // Menu entry: (re)write only when content differs, so the Exec/Icon paths stay
    // correct if the repo moves, without needless churn.
    let created = writeIfChanged(appsFile, entry, 0o755)
    if (created) {
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
    const deskFile = join(deskDir, 'pm-os.desktop')
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

    if (created) console.log('Installed Pm.Os launcher (app menu + desktop icon)')
  } else {
    // macOS: minimal .app bundle in ~/Applications. Finder double-click runs the
    // stub below (no Terminal window), which exec's the repo's launch script via
    // an absolute path baked in at install time.
    const appDir = join(home, 'Applications', 'Pm.Os.app')
    const macosDir = join(appDir, 'Contents', 'MacOS')
    const resDir = join(appDir, 'Contents', 'Resources')
    mkdirSync(macosDir, { recursive: true })
    mkdirSync(resDir, { recursive: true })

    // Icon: convert the committed PNG to .icns once (only if missing). Needs sips
    // + iconutil — both ship with macOS, but if anything goes wrong we just skip
    // the icon; the app still launches with the generic icon.
    const icnsFile = join(resDir, 'icon.icns')
    if (!existsSync(icnsFile) && existsSync(png)) {
      const iconset = join(tmpdir(), `pm-os-icon-${process.pid}.iconset`)
      try {
        mkdirSync(iconset, { recursive: true })
        for (const size of [16, 32, 128, 256, 512]) {
          execFileSync('sips', ['-z', `${size}`, `${size}`, png, '--out', join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
          execFileSync('sips', ['-z', `${size * 2}`, `${size * 2}`, png, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' })
        }
        execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsFile], { stdio: 'ignore' })
      } catch {
        try {
          rmSync(icnsFile, { force: true })
        } catch {}
      }
      try {
        rmSync(iconset, { recursive: true, force: true })
      } catch {}
    }
    const hasIcns = existsSync(icnsFile)

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Pm.Os</string>
  <key>CFBundleDisplayName</key>
  <string>Pm.Os</string>
  <key>CFBundleIdentifier</key>
  <string>dev.pmos.app</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>Pm.Os</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
${hasIcns ? '  <key>CFBundleIconFile</key>\n  <string>icon</string>\n' : ''}  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
`

    // The stub keeps no logic of its own: everything (PATH, build-if-missing,
    // logging) lives in launch-pm-os.sh, so updates there take effect without
    // reinstalling the .app.
    const stub = `#!/bin/bash
exec "${launcher}"
`

    // (Re)write plist + stub each run so the baked-in repo path stays current.
    let created = false
    if (writeIfChanged(join(appDir, 'Contents', 'Info.plist'), plist)) created = true
    if (writeIfChanged(join(macosDir, 'Pm.Os'), stub, 0o755)) created = true
    // chmod even when unchanged — the executable bit can be lost independently.
    try {
      chmodSync(join(macosDir, 'Pm.Os'), 0o755)
    } catch {}

    if (created) console.log('Installed Pm.Os launcher (macOS app in ~/Applications)')
  }
} catch {
  // Never block `pnpm dev` on launcher-install problems.
}
process.exit(0)
