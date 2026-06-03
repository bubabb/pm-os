import { getDb, pmDigestCache } from '@creare/database'
import { generateId } from '@creare/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { complete } from '@creare/ai-sdk'
import type { PmDigestCache } from '@creare/database'
import type { ClassifiedItem } from './types'

const DIGEST_TTL_MINUTES = 15

const DIGEST_PROMPTS: Record<PmDigestCache['digestType'], string> = {
  morning_brief: `You are a PM assistant generating a morning brief.
Given today's action items (classified as human or agent tasks), produce a concise morning brief with:
- 3-5 "Do Now" items the PM must handle personally (urgency 4-5)
- 3-5 "Delegate" items an AI agent can handle
Format as JSON: {"doNow":[{"title":string,"urgency":number,"source":string}],"delegate":[{"title":string,"action":string,"source":string}],"summary":string}`,

  sprint_health: `You are a PM assistant analyzing sprint health.
Given the current open tickets and PRs, assess sprint health and return:
Format as JSON: {"healthScore":1-10,"blockers":[string],"atRiskItems":[string],"summary":string,"recommendation":string}`,

  decisions_and_docs: `You are a PM assistant reviewing decisions and documentation.
Given recent meeting notes, Notion pages, and Confluence pages, identify:
- Key decisions made recently
- Documentation that may be outdated
Format as JSON: {"decisions":[{"title":string,"source":string}],"staleDocs":[{"title":string,"source":string,"daysSinceUpdate":number|null}],"summary":string}`,

  risk_radar: `You are a PM risk analyst.
Given current tickets, PRs, and project activity, identify risks:
Format as JSON: {"risks":[{"description":string,"severity":"high"|"medium"|"low","riskType":string,"suggestedResponse":string,"canDelegate":boolean}],"summary":string}`,
}

export async function generateDigest(
  projectId: string,
  digestType: PmDigestCache['digestType'],
  items: ClassifiedItem[],
  apiKey: string,
): Promise<PmDigestCache> {
  const db = getDb()

  const response = await complete(
    {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: DIGEST_PROMPTS[digestType],
      messages: [
        {
          role: 'user',
          content: JSON.stringify(
            items.slice(0, 40).map((i) => ({
              title: i.entity.title,
              source: i.entity.source,
              type: i.entity.entityType,
              bucket: i.bucket,
              urgency: i.urgency,
              riskType: i.riskType,
              suggestedAction: i.suggestedAction,
            })),
          ),
        },
      ],
      maxTokens: 1000,
      temperature: 0.2,
    },
    apiKey,
  )

  const validUntil = new Date(Date.now() + DIGEST_TTL_MINUTES * 60_000).toISOString()

  const [row] = await db
    .insert(pmDigestCache)
    .values({
      id: generateId(),
      projectId,
      digestType,
      content: response.content,
      generatedAt: new Date().toISOString(),
      validUntil,
      createdAt: new Date().toISOString(),
    })
    .returning()

  return row!
}

export async function getLatestDigest(
  projectId: string,
  digestType: PmDigestCache['digestType'],
): Promise<PmDigestCache | null> {
  const db = getDb()
  const now = new Date().toISOString()

  const [row] = await db
    .select()
    .from(pmDigestCache)
    .where(
      and(
        eq(pmDigestCache.projectId, projectId),
        eq(pmDigestCache.digestType, digestType),
        gt(pmDigestCache.validUntil, now),
      ),
    )
    .orderBy(pmDigestCache.generatedAt)
    .limit(1)

  return row ?? null
}
