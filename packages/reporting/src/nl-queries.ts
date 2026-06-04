import { complete } from '@creare/ai-sdk'
import { getDb, sprints, events } from '@creare/database'
import { and, eq, gte, desc } from 'drizzle-orm'

export async function queryProject(
  projectId: string,
  question: string,
  apiKey: string,
): Promise<string> {
  const db = getDb()
  const since72h = new Date(Date.now() - 72 * 3_600_000).toISOString()

  const recentEvents = await db
    .select({ type: events.type, payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.projectId, projectId), gte(events.createdAt, since72h)))
    .orderBy(desc(events.createdAt))
    .limit(30)

  const response = await complete(
    {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'You are a PM assistant with access to recent project activity. Answer the question concisely and factually based on the activity provided. If you cannot answer from the data, say so.',
      messages: [
        {
          role: 'user',
          content: `Recent project activity:\n${JSON.stringify(recentEvents, null, 2)}\n\nQuestion: ${question}`,
        },
      ],
      maxTokens: 500,
    },
    apiKey,
  )

  return response.content
}

export async function generateSprintSummary(sprintId: string, apiKey: string): Promise<string> {
  const db = getDb()
  const [sprint] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1)
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`)

  const response = await complete(
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a PM assistant. Generate a concise sprint summary covering: goal, what was completed, what was deferred, key decisions, velocity vs target.',
      messages: [{ role: 'user', content: `Sprint data: ${JSON.stringify(sprint)}` }],
      maxTokens: 600,
    },
    apiKey,
  )

  return response.content
}

export async function generateExecutiveSummary(projectId: string, apiKey: string): Promise<string> {
  const db = getDb()
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString()

  const recentEvents = await db
    .select({ type: events.type, payload: events.payload })
    .from(events)
    .where(and(eq(events.projectId, projectId), gte(events.createdAt, since7d)))
    .orderBy(desc(events.createdAt))
    .limit(50)

  const response = await complete(
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a PM assistant. Generate a 3-paragraph executive summary of the past week: what shipped, what is in progress, and what risks or decisions need executive attention. No jargon.',
      messages: [{ role: 'user', content: `Project activity (last 7 days):\n${JSON.stringify(recentEvents)}` }],
      maxTokens: 600,
    },
    apiKey,
  )

  return response.content
}

export async function generateChangelog(
  projectId: string,
  since: string,
  apiKey: string,
): Promise<string> {
  const db = getDb()

  const completionEvents = await db
    .select({ type: events.type, payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        gte(events.createdAt, since),
        eq(events.type, 'task.completed'),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(100)

  const response = await complete(
    {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'Generate a user-facing changelog from the completed tasks. Group by theme. Use plain language. Format as markdown with ## headers.',
      messages: [{ role: 'user', content: JSON.stringify(completionEvents) }],
      maxTokens: 800,
    },
    apiKey,
  )

  return response.content
}
