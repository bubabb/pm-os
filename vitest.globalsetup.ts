import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

// better-sqlite3 is a native addon and its single .node file may currently hold
// the Electron ABI (from running the desktop app). Swap it to the Node ABI before
// any test file loads it. Runs once in the main vitest process, before the `forks`
// pool spawns the per-file child processes that actually import the addon. This
// covers `pnpm test`, `test:watch`, and `test:coverage` — no manual rebuild needed.
export default function setup() {
  const script = fileURLToPath(new URL('./scripts/rebuild-better-sqlite3.mjs', import.meta.url))
  execFileSync(process.execPath, [script, 'ensure', 'node'], { stdio: 'inherit' })
}
