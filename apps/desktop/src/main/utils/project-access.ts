import { getDb, projects } from '@creare/database'
import { and, eq } from 'drizzle-orm'

export async function assertProjectAccess(
  projectId: string,
  userId: string,
): Promise<typeof projects.$inferSelect | null> {
  const db = getDb()
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
    .limit(1)
  return project ?? null
}
