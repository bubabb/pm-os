import { randomUUID } from 'crypto'

// All IDs in Creare are UUIDs — never auto-increment integers
// This ensures records can merge across machines without conflicts (sync-readiness)
export function generateId(): string {
  return randomUUID()
}
