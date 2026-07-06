import { randomBytes, createHash } from 'crypto'

// Real OAuth (browser-window flow) for app sign-in. GitHub + Microsoft Entra.
//
// Client credentials are read from the environment — never committed to the repo.
// If a provider is not configured, getOAuthConfig() returns null and the caller
// falls back to the Phase 1 dev-user stub, so the app still runs in development.
//
// Required env vars:
//   GitHub: PMOS_GITHUB_CLIENT_ID, PMOS_GITHUB_CLIENT_SECRET
//   Entra:  PMOS_ENTRA_CLIENT_ID, PMOS_ENTRA_CLIENT_SECRET, [PMOS_ENTRA_TENANT_ID=common]
//   Optional: PMOS_OAUTH_REDIRECT_URI (default http://localhost:4321/auth/oauth/callback)
//
// NOTE: interactive sign-in (capturing the redirect) is unavailable headless — see
// authorize() below. getOAuthConfig + the token/profile helpers are kept for a future
// non-interactive code source; today, connectors use PATs and app sign-in uses the dev-stub.

export type OAuthProvider = 'github' | 'entra'

export interface OAuthProfile {
  email: string
  name: string
  avatarUrl: string | null
}

interface OAuthConfig {
  clientId: string
  clientSecret: string
  authUrl: string
  tokenUrl: string
  scopes: string
  redirectUri: string
}

const DEFAULT_REDIRECT_URI = 'http://localhost:4321/auth/oauth/callback'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.length > 0 ? v : undefined
}

export function getOAuthConfig(provider: OAuthProvider): OAuthConfig | null {
  const redirectUri = env('PMOS_OAUTH_REDIRECT_URI') ?? DEFAULT_REDIRECT_URI

  if (provider === 'github') {
    const clientId = env('PMOS_GITHUB_CLIENT_ID')
    const clientSecret = env('PMOS_GITHUB_CLIENT_SECRET')
    if (!clientId || !clientSecret) return null
    return {
      clientId,
      clientSecret,
      authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: 'read:user user:email',
      redirectUri,
    }
  }

  // entra
  const clientId = env('PMOS_ENTRA_CLIENT_ID')
  const clientSecret = env('PMOS_ENTRA_CLIENT_SECRET')
  if (!clientId || !clientSecret) return null
  const tenant = env('PMOS_ENTRA_TENANT_ID') ?? 'common'
  return {
    clientId,
    clientSecret,
    authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: 'openid profile email User.Read',
    redirectUri,
  }
}

// PKCE (RFC 7636): protects the authorization-code exchange so an intercepted code
// is useless without the verifier. GitHub and Entra both accept S256; providers that
// ignore code_challenge simply fall back to the client_secret flow.
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Interactive authorization-code capture. The original flow intercepted the loopback
// redirect inside an Electron BrowserWindow; Pm.Os is now headless-only (no Electron),
// so there is no in-process window to intercept the redirect. This flow is therefore
// unavailable — connectors authenticate with a Personal Access Token, and app sign-in
// uses the dev-stub (PMOS_DEV_AUTH=1). Kept as a clear, throwing stub so a misconfigured
// OAuth env fails with an actionable message instead of a crash.
function authorize(cfg: OAuthConfig, state: string, codeChallenge: string): Promise<string> {
  void cfg
  void state
  void codeChallenge
  return Promise.reject(
    new Error(
      'Interactive OAuth sign-in is not available in headless Pm.Os (no desktop browser window to ' +
        'intercept the redirect). Use a Personal Access Token for connectors, or the dev sign-in (PMOS_DEV_AUTH=1).',
    ),
  )
}

async function exchangeCode(cfg: OAuthConfig, code: string, codeVerifier: string): Promise<string> {
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString(),
  })
  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status}`)
  }
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string }
  if (data.error || !data.access_token) {
    throw new Error(`Token exchange failed: ${data.error_description ?? data.error ?? 'no access_token'}`)
  }
  return data.access_token
}

async function fetchGitHubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const userRes = await fetch('https://api.github.com/user', { headers })
  if (!userRes.ok) throw new Error(`GitHub profile fetch failed: HTTP ${userRes.status}`)
  const user = (await userRes.json()) as {
    login: string
    name: string | null
    email: string | null
    avatar_url: string | null
  }

  let email = user.email
  if (!email) {
    // Primary email is not public — fetch it explicitly (requires user:email scope)
    const emailRes = await fetch('https://api.github.com/user/emails', { headers })
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null
    }
  }
  if (!email) throw new Error('Could not determine a verified email from GitHub')

  return { email, name: user.name ?? user.login, avatarUrl: user.avatar_url }
}

async function fetchEntraProfile(accessToken: string): Promise<OAuthProfile> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Microsoft profile fetch failed: HTTP ${res.status}`)
  const me = (await res.json()) as {
    displayName: string | null
    mail: string | null
    userPrincipalName: string | null
  }
  const email = me.mail ?? me.userPrincipalName
  if (!email) throw new Error('Could not determine an email from Microsoft Graph')
  return { email, name: me.displayName ?? email, avatarUrl: null }
}

// Runs the OAuth code flow and returns the authenticated profile. The interactive
// `authorize()` step is unavailable headless (see its note) and rejects, so this only
// completes if a non-interactive code source is ever wired in.
export async function performOAuthFlow(provider: OAuthProvider, cfg: OAuthConfig): Promise<OAuthProfile> {
  const state = randomBytes(16).toString('hex')
  const { verifier, challenge } = pkcePair()
  const code = await authorize(cfg, state, challenge)
  const accessToken = await exchangeCode(cfg, code, verifier)
  return provider === 'github'
    ? fetchGitHubProfile(accessToken)
    : fetchEntraProfile(accessToken)
}
