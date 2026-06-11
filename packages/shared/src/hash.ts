// Deterministic content hash — used as the 3-way-merge base for bidirectional sync
// Canonicalizes to JSON with recursively sorted object keys, so logically-equal
// objects hash identically regardless of key insertion order. Arrays keep order.
// undefined is treated like JSON.stringify does: omitted from objects, null in arrays.
// Pure, synchronous, node builtins only (node:crypto)
import { createHash } from 'node:crypto'

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    return `{${entries.join(',')}}`
  }
  // Primitives: string, number, boolean, null
  // Non-JSON values (undefined, functions) normalize to null, matching JSON array behavior
  return JSON.stringify(value) ?? 'null'
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
