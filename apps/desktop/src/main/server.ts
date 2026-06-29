import { existsSync } from 'fs'
import { join } from 'path'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { authRoutes } from './routes/auth'
import { projectsRoutes } from './routes/projects'
import { usersRoutes } from './routes/users'
import { secretsRoutes } from './routes/secrets'
import { eventsRoutes } from './routes/events'
import { notificationsRoutes } from './routes/notifications'
import { integrationsRoutes } from './routes/integrations'
import { connectionsRoutes } from './routes/connections'
import { globalSettingsRoutes } from './routes/global-settings'
import { reportingRoutes } from './routes/reporting'
import { orchestrationRoutes } from './routes/orchestration'
import { boardsRoutes } from './routes/boards'
import { mirrorsRoutes } from './routes/mirrors'
import { mirrorCardsRoutes } from './routes/mirror-cards'
import { conflictsRoutes } from './routes/conflicts'
import { observabilityRoutes } from './routes/observability'
import { toolsRoutes } from './routes/tools'
import { evalRoutes } from './routes/eval'
import { memoryRoutes } from './routes/memory'
import { checkClaudeCli } from '@creare/ai-sdk'

const PORT = parseInt(process.env['CREARE_PORT'] ?? '4321', 10)

// The SSE fallback authenticates via the query string (/events/stream?token=<JWT>),
// so the logged URL must be scrubbed too — redacting the Authorization header alone
// still leaks the full session token on every SSE connect in dev.
function redactUrlToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, '$1[REDACTED]')
}

// Locate the built web UI (plain-Vite build → apps/desktop/out/web). Only the
// headless "Creare Server" runtime serves the renderer over HTTP; the Electron
// app loads it via loadFile and never hits this. Returns null when no build
// exists (e.g. Electron-only checkout) so we register nothing and stay an API.
function resolveWebDir(): string | null {
  const override = process.env['CREARE_WEB_DIR']
  const candidates = [
    ...(override ? [override] : []),
    join(__dirname, '../../out/web'), // running from src/main (tsx headless)
    join(__dirname, '../web'), // running from out/main (bundled)
  ]
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null
}

// Serve the React SPA as static files with a fallback to index.html for any
// non-API GET (the app uses HashRouter, so this is mostly belt-and-suspenders).
// Registered AFTER the API routes, so every real route still wins; only unknown
// paths fall through here.
async function registerWebUi(app: FastifyInstance): Promise<void> {
  // Opt-in: only the headless "Creare Server" runtime sets CREARE_SERVE_WEB.
  // The Electron app loads the renderer via file:// and must NOT have static
  // serving / a custom 404 handler grafted onto its API server.
  if (process.env['CREARE_SERVE_WEB'] !== '1') return

  const webDir = resolveWebDir()
  if (!webDir) {
    console.warn('[creare] CREARE_SERVE_WEB=1 but no web build found — run `pnpm web:build`')
    return
  }

  await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false })

  app.setNotFoundHandler((request, reply) => {
    const wantsHtml =
      request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')
    if (wantsHtml) return reply.sendFile('index.html')
    return reply.code(404).send({ error: 'Not found' })
  })

  console.log(`[creare] serving web UI from ${webDir}`)
}

const app = Fastify({
  logger:
    process.env['NODE_ENV'] === 'development'
      ? {
          redact: ['req.headers.authorization', 'res.headers["set-cookie"]'],
          serializers: {
            // Mirrors Fastify's default request log shape, with the token query
            // param stripped from the URL.
            req(request: FastifyRequest) {
              return {
                method: request.method,
                url: redactUrlToken(request.url),
                hostname: request.hostname,
                remoteAddress: request.ip,
                remotePort: request.socket.remotePort ?? 0,
              }
            },
          },
        }
      : false,
})

export async function startServer(): Promise<void> {
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (Electron renderer) and localhost origins
      if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        cb(null, true)
      } else {
        cb(new Error('Not allowed by CORS'), false)
      }
    },
  })

  await app.register(swagger, {
    openapi: {
      info: { title: 'Creare API', version: '1.0.0', description: 'Creare local API' },
      servers: [{ url: `http://localhost:${PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  })

  await app.register(swaggerUi, { routePrefix: '/docs' })

  // Health check — no auth required
  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }))

  await app.register(authRoutes)
  await app.register(projectsRoutes)
  await app.register(usersRoutes)
  await app.register(secretsRoutes)
  await app.register(eventsRoutes)
  await app.register(notificationsRoutes)
  await app.register(integrationsRoutes)
  await app.register(connectionsRoutes)
  await app.register(globalSettingsRoutes)
  await app.register(reportingRoutes)
  await app.register(orchestrationRoutes)
  await app.register(boardsRoutes)
  await app.register(mirrorsRoutes)
  await app.register(mirrorCardsRoutes)
  await app.register(conflictsRoutes)
  await app.register(observabilityRoutes)
  await app.register(toolsRoutes)
  await app.register(evalRoutes)
  await app.register(memoryRoutes)

  // Serve the web UI last so every API route takes precedence (headless mode).
  await registerWebUi(app)

  await app.listen({ port: PORT, host: '127.0.0.1' })
  console.log(`[creare] API server running on http://127.0.0.1:${PORT}`)

  // Reasoning defaults to the membership-backed claude-cli provider — verify it's
  // installed and signed in, and surface a clear line in the terminal if not.
  // Non-blocking: never delays or fails server startup.
  void checkClaudeCli()
    .then((h) => {
      const tag = '[creare] reasoning (claude-cli):'
      if (h.ok) console.log(`${tag} ${h.message}`)
      else console.warn(`${tag} ${h.message}`)
    })
    .catch(() => {})
}

export async function stopServer(): Promise<void> {
  await app.close()
}
