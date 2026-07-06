import { complete, extractJson } from '@pm-os/ai-sdk'
import type { ModelProvider } from '@pm-os/ai-sdk'
import { getDb, externalEventCache } from '@pm-os/database'
import { eq } from 'drizzle-orm'
import type { ExternalEventCache } from '@pm-os/database'
import type { ClassifiedItem, NormalizedEntity, ActionBucket } from './types'

type Classification = {
  bucket: ActionBucket
  urgency: 1 | 2 | 3 | 4 | 5
  riskType: string | null
  suggestedAction: string
}

// Stage 1: deterministic rule engine — no LLM cost
function applyRules(entity: NormalizedEntity): Classification | null {
  const raw = entity.raw

  // Always human — high-stakes signals
  if (/budget|sign.?off|escalat/i.test(entity.title)) {
    return { bucket: 'human', urgency: 5, riskType: 'decision', suggestedAction: 'Review and approve' }
  }
  if (/architect|design review/i.test(entity.title)) {
    return { bucket: 'human', urgency: 4, riskType: 'decision', suggestedAction: 'Provide architectural guidance' }
  }
  if (Array.isArray(raw['labels']) && (raw['labels'] as string[]).includes('security')) {
    return { bucket: 'human', urgency: 5, riskType: 'security', suggestedAction: 'Security review required' }
  }
  if (
    entity.entityType === 'pr' &&
    raw['isDraft'] === false &&
    typeof raw['requestedReviewers'] === 'number' &&
    (raw['requestedReviewers'] as number) > 0
  ) {
    return { bucket: 'human', urgency: 4, riskType: null, suggestedAction: 'Review pull request' }
  }

  // Always agent — clearly delegatable
  // Dropped the `entity.assignee === null` condition this rule used to also
  // require: Jira's fetchEntities JQL is `assignee = currentUser()`, so every
  // 'ticket' entity that reaches the classifier already has an assignee (the
  // current user) — that condition could never be true and made this branch
  // unreachable. The unlabeled-ticket signal is still meaningful on its own.
  if (
    entity.entityType === 'ticket' &&
    Array.isArray(raw['labels']) && (raw['labels'] as string[]).length === 0
  ) {
    return { bucket: 'agent', urgency: 2, riskType: null, suggestedAction: 'Triage: add labels' }
  }
  if (entity.entityType === 'file' && entity.source === 'onedrive') {
    return { bucket: 'agent', urgency: 2, riskType: null, suggestedAction: 'Summarise meeting notes and extract action items' }
  }
  if (entity.entityType === 'page' && entity.source === 'confluence') {
    return { bucket: 'agent', urgency: 1, riskType: null, suggestedAction: 'Check documentation drift against recent PRs' }
  }
  if (entity.entityType === 'note' && entity.source === 'notion') {
    return { bucket: 'agent', urgency: 2, riskType: null, suggestedAction: 'Extract decisions and action items' }
  }

  return null // ambiguous — pass to Stage 2
}

const CLASSIFIER_SYSTEM = `You are a PM action classifier for a DevOps platform.
Given a software development entity (ticket, PR, page, file, etc.), decide:
1. Does it require human judgment (approve, escalate, strategic decision, security review)?
2. Or can an AI agent handle it (summarise, label, triage, update documentation)?

Respond with JSON only — no markdown, no explanation:
{"bucket":"human"|"agent","urgency":1|2|3|4|5,"riskType":string|null,"suggestedAction":string}

urgency: 5=critical/today, 4=high/this session, 3=medium/today, 2=low/this week, 1=watch`

async function classifyWithLLM(
  entity: NormalizedEntity,
  apiKey: string,
  provider: ModelProvider,
  model: string,
): Promise<Classification> {
  try {
    const response = await complete(
      {
        provider,
        model,
        systemPrompt: CLASSIFIER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              source: entity.source,
              type: entity.entityType,
              title: entity.title,
              status: entity.status,
              assignee: entity.assignee,
              updatedAt: entity.updatedAt,
              labels: entity.raw['labels'],
            }),
          },
        ],
        maxTokens: 200,
        temperature: 0,
      },
      apiKey,
    )

    // Models often wrap "JSON only" output in a ```json fence (the claude-cli /
    // membership model does) — extractJson tolerates fences + stray prose.
    const parsed = extractJson<{
      bucket: ActionBucket
      urgency: number
      riskType: string | null
      suggestedAction: string
    }>(response.content)

    return {
      bucket: parsed.bucket === 'agent' ? 'agent' : 'human',
      urgency: (Math.max(1, Math.min(5, parsed.urgency ?? 3)) as 1 | 2 | 3 | 4 | 5),
      riskType: parsed.riskType ?? null,
      suggestedAction: parsed.suggestedAction ?? 'Review manually',
    }
  } catch {
    return { bucket: 'human', urgency: 3, riskType: null, suggestedAction: 'Review manually' }
  }
}

// Run async tasks with at most `limit` concurrent executions
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let idx = 0

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const current = idx++
      results[current] = await fn(items[current]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Parse a persisted classification — null if missing or malformed
function parseCachedClassification(row: ExternalEventCache): Classification | null {
  if (!row.classification) return null
  try {
    const c = JSON.parse(row.classification) as Classification
    if (c.bucket !== 'human' && c.bucket !== 'agent') return null
    return c
  } catch {
    return null
  }
}

// Persist a classification on its cache row so subsequent dashboard loads skip
// re-classifying. Cache rows are immutable per fetch — a fresh fetch creates a
// new row with a null classification, so a stored result never goes stale.
function persistClassification(rowId: string, c: Classification): void {
  getDb()
    .update(externalEventCache)
    .set({ classification: JSON.stringify(c), classifiedAt: new Date().toISOString() })
    .where(eq(externalEventCache.id, rowId))
    .run()
}

export async function classifyItems(
  cacheRows: ExternalEventCache[],
  apiKey: string,
  provider: ModelProvider,
  model: string,
): Promise<ClassifiedItem[]> {
  // Parse all payloads first — skip malformed rows
  const parsed: Array<{ row: ExternalEventCache; entity: NormalizedEntity }> = []
  for (const row of cacheRows) {
    try {
      parsed.push({ row, entity: JSON.parse(row.payload) as NormalizedEntity })
    } catch {
      // skip malformed
    }
  }

  // Stage 0: persisted classifications — no rules, no LLM
  const cachedResults = parsed.map(({ row }) => parseCachedClassification(row))

  // Stage 1: rule engine (synchronous, zero LLM cost)
  const ruleResults = parsed.map(({ entity }, i) =>
    cachedResults[i] ? null : applyRules(entity),
  )

  // Stage 2: LLM for ambiguous items only — run in parallel, max 5 concurrent
  const ambiguousIndices = ruleResults
    .map((r, i) => (r === null && cachedResults[i] === null ? i : -1))
    .filter((i) => i !== -1)

  const llmResults = await withConcurrency(
    ambiguousIndices,
    5,
    (i) => classifyWithLLM(parsed[i]!.entity, apiKey, provider, model),
  )

  // Merge results
  const llmMap = new Map(ambiguousIndices.map((idx, pos) => [idx, llmResults[pos]!]))

  return parsed.map(({ row, entity }, i) => {
    const cached = cachedResults[i]
    const c = cached ?? ruleResults[i] ?? llmMap.get(i)!
    if (!cached) persistClassification(row.id, c)
    return {
      entity,
      bucket: c.bucket,
      urgency: c.urgency,
      riskType: c.riskType,
      suggestedAction: c.suggestedAction,
    }
  })
}
