// Build / swap the native better-sqlite3 addon between the Node (vitest) and
// Electron (desktop app / Playwright E2E) ABIs.
//
//   node scripts/rebuild-better-sqlite3.mjs node             # force a fresh Node build
//   node scripts/rebuild-better-sqlite3.mjs electron         # force a fresh Electron build
//   node scripts/rebuild-better-sqlite3.mjs ensure node      # make Node ABI live (copy cache, else build)
//   node scripts/rebuild-better-sqlite3.mjs ensure electron  # make Electron ABI live (copy cache, else build)
//
// One .node file can only match one ABI at a time, so tests and the app collide:
// whichever ran a `rebuild` last wins. `ensure` fixes that — it keeps a cached
// copy of each ABI under .sqlite-abi/ and, when the live binary is the wrong ABI,
// swaps it in with an instant file copy instead of a ~15s recompile. The test and
// app commands call `ensure` automatically (vitest globalSetup + predev/pree2e),
// so `pnpm test` and launching the app each "just work" without manual switching.
//
// Cache files are tagged with platform-arch, so a cache synced from another
// machine (Syncthing carries ~/projects) is simply ignored — it falls back to a
// local build rather than loading an incompatible binary.
import { readdirSync, existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const ensure = argv[0] === 'ensure'
const target = (ensure ? argv[1] : argv[0]) === 'electron' ? 'electron' : 'node'

const pnpmDir = join(repoRoot, 'node_modules/.pnpm')
const find = (prefix) => {
  const e = readdirSync(pnpmDir).find((d) => d.startsWith(prefix))
  if (!e) throw new Error(`${prefix}* not found under node_modules/.pnpm — run pnpm install first`)
  return e
}

const bsqDir = join(pnpmDir, find('better-sqlite3@'), 'node_modules/better-sqlite3')
const liveBinary = join(bsqDir, 'build/Release/better_sqlite3.node')
const markerFile = join(bsqDir, 'build/Release/.abi-target')
const cacheDir = join(repoRoot, '.sqlite-abi')
const cacheFor = (t) => join(cacheDir, `better_sqlite3.${t}.${process.platform}-${process.arch}.node`)

const liveTarget = () => {
  try {
    return readFileSync(markerFile, 'utf8').trim()
  } catch {
    return null
  }
}

const build = (t) => {
  let cmd = 'npx -y node-gyp rebuild --release'
  if (t === 'electron') {
    const ev = find('electron@').replace('electron@', '').replace(/_.*/, '')
    cmd += ` --runtime=electron --target=${ev} --dist-url=https://electronjs.org/headers --arch=${process.arch}`
  }
  console.log(`Rebuilding better-sqlite3 for ${t} in ${bsqDir}`)
  execSync(cmd, { cwd: bsqDir, stdio: 'inherit' })
  // Cache the freshly built ABI for instant future swaps, and mark it live.
  mkdirSync(cacheDir, { recursive: true })
  copyFileSync(liveBinary, cacheFor(t))
  writeFileSync(markerFile, t)
}

if (!ensure) {
  build(target)
} else if (liveTarget() === target && existsSync(liveBinary)) {
  console.log(`better-sqlite3 already built for ${target} — nothing to do`)
} else if (existsSync(cacheFor(target))) {
  console.log(`Swapping better-sqlite3 to cached ${target} ABI`)
  copyFileSync(cacheFor(target), liveBinary)
  writeFileSync(markerFile, target)
} else {
  console.log(`No cached ${target} ABI for ${process.platform}-${process.arch} — building it once`)
  build(target)
}
