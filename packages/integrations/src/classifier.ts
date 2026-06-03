import { complete } from '@creare/ai-sdk'
import type { ExternalEventCache } from '@creare/database'
import type { ClassifiedItem, NormalizedEntity, ActionBucket } from './types'

type RuleResult = {
  bucket: ActionBucket
  urgency: 1 | 2 | 3 | 4 | 5
  riskType: string | null
  suggestedAction: string
} | null

// Stage 1: deterministic rule engine — no LLM cost
function applyRules(entity: NormalizedEntity): RuleResult {
  const titleLower = entity.title.toLowerCase()
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
  // PR ready for review (not draft, has reviewers requested)
  if (
    entity.entityType === 'pr' &&
    raw['isDraft'] === false &&
    typeof raw['requestedReviewers'] === 'number' &&
    (raw['requestedReviewers'] as number) > 0
  ) {
    return { bucket: 'human', urgency: 4, riskType: null, suggestedAction: 'Review pull request' }
  }

  // Always agent — clearly delegatable
  if (
    entity.entityType === 'ticket' &&
    Array.isArray(raw['labels']) && (raw['labels'] as string[]).length === 0 &&
    entity.assignee === null
  ) {
    return { bucket: 'agent', urgency: 2, riskType: null, suggestedAction: 'Triage: add labels and assignee' }
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

  void titleLower
  return null // ambiguous — pass to Stage 2
}

const CLASSIFIER_SYSTEM = `You are a PM action classifier for a DevOps platform.
Given a software development entity (ticket, PR, page, file, etc.), decide:
1. Does it require human judgment (approve, escalate, strategic decision, security review)?
2. Or can an AI agent handle it (summarise, label, triage, update documentation)?

Respond with JSON only — no markdown, no explanation:
{"bucket":"human"|"agent","urgency":1|2|3|4|5,"riskType":string|null,"suggestedAction":string}

urgency: 5=critical/today, 4=high/this session, 3=medium/today, 2=low/this week, 1=watch`

async function classifyWithLLM(entity: NormalizedEntity, apiKey: string): Promise<RuleResult> {
  try {
    const response = await complete(
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
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

    const parsed = JSON.parse(response.content) as {
      bucket: ActionBucket
      urgency: number
      riskType: string | null
      suggestedAction: string
    }

    return {
      bucket: parsed.bucket === 'agent' ? 'agent' : 'human',
      urgency: (Math.max(1, Math.min(5, parsed.urgency ?? 3)) as 1 | 2 | 3 | 4 | 5),
      riskType: parsed.riskType ?? null,
      suggestedAction: parsed.suggestedAction ?? 'Review manually',
    }
  } catch {
    // On any failure: err on the side of human review
    return { bucket: 'human', urgency: 3, riskType: null, suggestedAction: 'Review manually' }
  }
}

export async function classifyItems(
  cacheRows: ExternalEventCache[],
  apiKey: string,
): Promise<ClassifiedItem[]> {
  const results: ClassifiedItem[] = []

  for (const row of cacheRows) {
    let entity: NormalizedEntity
    try {
      entity = JSON.parse(row.payload) as NormalizedEntity
    } catch {
      continue
    }

    const ruleResult = applyRules(entity)
    // classification is always non-null: ruleResult is null only for ambiguous items which go to LLM
    const c = ruleResult ?? await classifyWithLLM(entity, apiKey)
    if (!c) continue

    results.push({
      entity,
      bucket: c.bucket,
      urgency: c.urgency,
      riskType: c.riskType,
      suggestedAction: c.suggestedAction,
    })
  }

  return results
}
