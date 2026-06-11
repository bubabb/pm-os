import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import { getBoard, getBoardItem, getColumn, listColumns, addBoardItem } from '@creare/boards'
import { createTask, updateTask } from '@creare/agent-orchestration'
import {
  enqueueItemCreate,
  enqueueItemUpdate,
  enqueueItemClose,
  enqueueItemComment,
} from '@creare/integrations'
import { kickPushWorker } from '../sync/push-worker'
import { getDb, remoteLinks, tasks, events } from '@creare/database'
import { and, eq, isNull } from 'drizzle-orm'
import { generateId } from '@creare/shared'

// Bidirectional card LIFECYCLE — create / edit / close / comment on a mirrored
// board, applied locally first (local-first), then pushed to the remote
// (GitHub / Jira / Notion) via the durable outbox + push worker. On a plain
// local board the enqueue helpers return null and nothing is pushed — these
// routes work identically for unmirrored boards (except /comment, which has
// no local side and therefore requires a mirror).
//
// Outbox contract (packages/integrations/src/mirror/outbox.ts): the enqueue
// helpers NEVER throw — they return an opId (a durable op row exists) or null
// (not mirrored). The enqueue is AWAITED so the op row exists before we
// respond (a pull racing the response can't silently revert the change); the
// push-worker kick stays fire-and-forget.

interface BoardParams   { id: string; boardId: string }
interface CardParams    { id: string; boardId: string; itemId: string }

interface CreateCardBody  { title: string; columnId?: string }
interface UpdateCardBody  { title: string }
interface CommentCardBody { body: string }

// Sub-resource ownership guards — same pattern as routes/boards.ts.
function boardInProject(boardId: string, projectId: string): boolean {
  const b = getBoard(boardId)
  return b !== null && b.projectId === projectId
}
function itemInBoard(itemId: string, boardId: string): boolean {
  const i = getBoardItem(itemId)
  return i !== null && i.boardId === boardId
}
// A board is mirrored when it has a live (non-tombstoned) board-level remote
// link belonging to the project in the URL.
function boardMirrored(boardId: string, projectId: string): boolean {
  const link = getDb()
    .select()
    .from(remoteLinks)
    .where(and(
      eq(remoteLinks.localType, 'board'),
      eq(remoteLinks.localId, boardId),
      isNull(remoteLinks.deletedAt),
    ))
    .get()
  return link !== undefined && link.projectId === projectId
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export async function mirrorCardsRoutes(app: FastifyInstance): Promise<void> {
  // Create a card: local task (type 'human') + board_item in the target column
  // (first column when omitted); if the board is mirrored, enqueue create_item.
  // The op payload carries the new board_item id — processOp links the remote
  // id the connector mints back onto the item when the push succeeds.
  app.post<{ Params: BoardParams; Body: CreateCardBody }>(
    '/projects/:id/boards/:boardId/cards',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams; Body: CreateCardBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })

      const { title, columnId } = request.body
      if (!nonEmptyString(title)) return reply.code(400).send({ error: 'title is required' })

      let targetColumnId: string
      if (columnId !== undefined) {
        const col = getColumn(columnId)
        if (col === null || col.boardId !== request.params.boardId) {
          return reply.code(422).send({ error: 'Column does not belong to this board' })
        }
        targetColumnId = col.id
      } else {
        const first = listColumns(request.params.boardId)[0] // ordered by position
        if (first === undefined) return reply.code(422).send({ error: 'Board has no columns' })
        targetColumnId = first.id
      }

      const task = createTask(request.params.id, { title, type: 'human' }, user.id)
      const item = addBoardItem(request.params.boardId, targetColumnId, task.id)

      // null = board not mirrored — plain local boards push nothing.
      const opId = await enqueueItemCreate(item.id, title)
      if (opId !== null) kickPushWorker()
      return item
    },
  )

  // Edit a card's title: update the backing task locally, then push update_item.
  app.patch<{ Params: CardParams; Body: UpdateCardBody }>(
    '/projects/:id/boards/:boardId/cards/:itemId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: CardParams; Body: UpdateCardBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      if (!itemInBoard(request.params.itemId, request.params.boardId)) return reply.code(404).send({ error: 'Item not found' })

      const { title } = request.body
      if (!nonEmptyString(title)) return reply.code(400).send({ error: 'title is required' })

      const item = getBoardItem(request.params.itemId)!
      const db = getDb()
      const task = db.select().from(tasks).where(eq(tasks.id, item.taskId)).get()
      if (task === undefined) return reply.code(404).send({ error: 'Task not found' })

      // Title write is direct: no domain API exposes task-title updates
      // (agent-orchestration's updateTask deliberately excludes title), and
      // this route owns only its own file. Mirrors the tasks-table write
      // applyMirrorSnapshot performs, with the same append-only event.
      if (task.title !== title) {
        const now = new Date().toISOString()
        db.update(tasks).set({ title, updatedAt: now }).where(eq(tasks.id, task.id)).run()
        db.insert(events).values({
          id: generateId(),
          type: 'task.updated',
          domain: 'boards',
          projectId: request.params.id,
          actorType: 'user',
          actorId: user.id,
          resourceType: 'task',
          resourceId: task.id,
          payload: JSON.stringify({ changed: ['title'], from: { title: task.title }, to: { title } }),
        }).run()
      }

      const opId = await enqueueItemUpdate(request.params.itemId, { title })
      if (opId !== null) kickPushWorker()
      return { ok: true }
    },
  )

  // Close a card: mark the backing task completed locally, then push close_item.
  app.post<{ Params: CardParams }>(
    '/projects/:id/boards/:boardId/cards/:itemId/close',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: CardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      if (!itemInBoard(request.params.itemId, request.params.boardId)) return reply.code(404).send({ error: 'Item not found' })

      const item = getBoardItem(request.params.itemId)!
      const closed = updateTask(item.taskId, { status: 'completed' }, user.id)
      if (closed === null) return reply.code(404).send({ error: 'Task not found' })

      const opId = await enqueueItemClose(request.params.itemId)
      if (opId !== null) kickPushWorker()
      return { ok: true }
    },
  )

  // Comment on a card: push-only — comments have no local representation, so
  // this is meaningless (400) on an unmirrored board or an item that has no
  // remote counterpart yet (created locally, push still in flight).
  app.post<{ Params: CardParams; Body: CommentCardBody }>(
    '/projects/:id/boards/:boardId/cards/:itemId/comment',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: CardParams; Body: CommentCardBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      if (!itemInBoard(request.params.itemId, request.params.boardId)) return reply.code(404).send({ error: 'Item not found' })

      const { body } = request.body
      if (!nonEmptyString(body)) return reply.code(400).send({ error: 'body is required' })
      if (!boardMirrored(request.params.boardId, request.params.id)) {
        return reply.code(400).send({ error: 'Board is not mirrored' })
      }

      const opId = await enqueueItemComment(request.params.itemId, body)
      if (opId === null) {
        // Board is mirrored but the item has no remote link yet — its create
        // push hasn't landed. Nothing was enqueued.
        return reply.code(400).send({ error: 'Card has no remote counterpart yet — try again after sync' })
      }
      kickPushWorker()
      return { ok: true }
    },
  )
}
