// Creare — Team Memory / Adaptive Learning (Phase 4)
// Durable learnings captured from agent runs, reviews, and evals, recalled to inform
// future work. Retrieval is a lightweight tag + keyword ranking for v1 (no FTS yet).

import { getDb, learnings, events } from '@creare/database'
import { generateId } from '@creare/shared'
import { and, eq, desc } from 'drizzle-orm'
import type { Learning } from '@creare/database'

export type LearningSource = 'agent_run' | 'review' | 'eval' | 'manual'

export interface RecordLearningParams {
  source: LearningSource
  title: string
  content: string
  taskId?: string
  tags?: string[]
}

export interface RecallQuery {
  text?: string
  tags?: string[]
  limit?: number
}

function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as unknown[]).filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

// Records a learning and emits an append-only event.
export function recordLearning(projectId: string, params: RecordLearningParams, actorId?: string): Learning {
  const id = generateId()
  getDb()
    .insert(learnings)
    .values({
      id,
      projectId,
      source: params.source,
      taskId: params.taskId ?? null,
      title: params.title,
      content: params.content,
      tags: JSON.stringify(params.tags ?? []),
    })
    .run()

  getDb()
    .insert(events)
    .values({
      id: generateId(),
      type: 'learning.recorded',
      domain: 'memory',
      projectId,
      actorType: actorId ? 'user' : 'system',
      actorId: actorId ?? null,
      resourceType: 'learning',
      resourceId: id,
      payload: JSON.stringify({ source: params.source, title: params.title }),
    })
    .run()

  return getDb().select().from(learnings).where(eq(learnings.id, id)).limit(1).all()[0]!
}

// Lists learnings for a project (newest first), optionally filtered by source.
export function listLearnings(projectId: string, opts?: { source?: LearningSource; limit?: number }): Learning[] {
  const db = getDb()
  const where = opts?.source
    ? and(eq(learnings.projectId, projectId), eq(learnings.source, opts.source))
    : eq(learnings.projectId, projectId)
  const rows = db.select().from(learnings).where(where).orderBy(desc(learnings.createdAt)).all()
  return opts?.limit ? rows.slice(0, opts.limit) : rows
}

// Recalls the most relevant learnings for a query. Tag overlap is weighted highest,
// then a title hit, then a content hit. With no criteria, returns the most recent.
export function recallLearnings(projectId: string, query: RecallQuery = {}): Learning[] {
  const all = listLearnings(projectId)
  const text = query.text?.toLowerCase()
  const wantTags = query.tags ?? []
  const limit = query.limit ?? 10

  if (!text && wantTags.length === 0) return all.slice(0, limit)

  const scored = all.map((l) => {
    let score = 0
    if (wantTags.length) {
      const tags = parseTags(l.tags)
      score += wantTags.filter((t) => tags.includes(t)).length * 2
    }
    if (text) {
      if (l.title.toLowerCase().includes(text)) score += 2
      if (l.content.toLowerCase().includes(text)) score += 1
    }
    return { l, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.l)
}
