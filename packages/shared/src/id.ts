// All IDs in Pm.Os are UUIDs — never auto-increment integers
// This ensures records can merge across machines without conflicts (sync-readiness)
// Uses globalThis.crypto.randomUUID() — works in Node.js ≥19 and modern browsers (renderer-safe)
export function generateId(): string {
  return globalThis.crypto.randomUUID()
}
