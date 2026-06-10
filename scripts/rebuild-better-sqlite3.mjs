// Rebuild the native better-sqlite3 addon for a given runtime ABI.
//
//   node scripts/rebuild-better-sqlite3.mjs node       # for vitest (system Node)
//   node scripts/rebuild-better-sqlite3.mjs electron    # for the desktop app / Playwright E2E
//
// One .node file can only match one ABI at a time, so switch with these before
// running tests vs. running the app. See README / PROGRESS.
import { readdirSync } from 'fs'
import { execSync } from 'child_process'

const target = process.argv[2] === 'electron' ? 'electron' : 'node'
const pnpmDir = 'node_modules/.pnpm'
const find = (prefix) => {
  const e = readdirSync(pnpmDir).find((d) => d.startsWith(prefix))
  if (!e) throw new Error(`${prefix}* not found under ${pnpmDir} — run pnpm install first`)
  return e
}

const bsqDir = `${pnpmDir}/${find('better-sqlite3@')}/node_modules/better-sqlite3`
let cmd = 'npx -y node-gyp rebuild --release'
if (target === 'electron') {
  const ev = find('electron@').replace('electron@', '').replace(/_.*/, '')
  cmd += ` --runtime=electron --target=${ev} --dist-url=https://electronjs.org/headers --arch=${process.arch}`
}
console.log(`Rebuilding better-sqlite3 for ${target} in ${bsqDir}`)
execSync(cmd, { cwd: bsqDir, stdio: 'inherit' })
