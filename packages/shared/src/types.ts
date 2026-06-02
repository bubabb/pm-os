// Base types shared across all Creare packages
// See docs/GLOSSARY.md for canonical definitions of all terms

export type ID = string // UUID v4

export type Timestamp = string // ISO 8601

export interface BaseEntity {
  id: ID
  createdAt: Timestamp
  updatedAt: Timestamp
}
