import { getBrowserWindowCtor } from '../electron-optional'
import { randomBytes, createHash } from 'crypto'

// Real OAuth (browser-window flow) for app sign-in. GitHub + Microsoft Entra.
//
// Client credentials are read from the environment — never committed to the repo.
// If a provider is not configured, getOAuthConfig() returns null and the caller
// falls back to the Phase 1 dev-user stub, so the app still runs in development.
//
// Required env vars:
//   GitHub: CREARE_GITHUB_CLIENT_ID, CREARE_GITHUB_CLIENT_SECRET
//   Entra:  CREARE_ENTRA_CLIENT_ID, CREARE_ENTRA_CLIENT_SECRET, [CREARE_ENTRA_TENANT_ID=common]
//   Optional: CREARE_OAUTH_REDIRECT_URI (default http://localhost:4321/auth/oauth/callback)
//
// The redirect URI must exactly match the one registered on the OAuth app. We do
// not run an HTTP listener for it — the Electron BrowserWindow's navigation to the
// loopback URL is intercepted in-process before the request is ever sent.

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
  const redirectUri = env('CREARE_OAUTH_REDIRECT_URI') ?? DEFAULT_REDIRECT_URI

  if (provider === 'github') {
    const clientId = env('CREARE_GITHUB_CLIENT_ID')
    const clientSecret = env('CREARE_GITHUB_CLIENT_SECRET')
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
  const clientId = env('CREARE_ENTRA_CLIENT_ID')
  const clientSecret = env('CREARE_ENTRA_CLIENT_SECRET')
  if (!clientId || !clientSecret) return null
  const tenant = env('CREARE_ENTRA_TENANT_ID') ?? 'common'
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

// Opens a modal OAuth window, intercepts the loopback redirect, and returns the
// authorization code. Rejects if the user closes the window or the provider
// returns an error / mismatched state.
function authorize(cfg: OAuthConfig, state: string, codeChallenge: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: cfg.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  const authUrl = `${cfg.authUrl}?${params.toString()}`

  // OAuth sign-in needs an Electron window to intercept the loopback redirect.
  // The headless server has no Electron — fail clearly instead of crashing on import.
  const BrowserWindow = getBrowserWindowCtor()
  if (!BrowserWindow) {
    return Promise.reject(
      new Error(
        'OAuth sign-in requires the Creare desktop app (Electron). In headless mode, authenticate connectors with a Personal Access Token instead.',
      ),
    )
  }

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    show: true,
    autoHideMenuBar: true,
    title: 'Sign in',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  return new Promise<string>((resolve, reject) => {
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      win.removeAllListeners('closed')
      if (!win.isDestroyed()) win.close()
      fn()
    }

    const handleRedirect = (url: string, preventDefault: () => void): void => {
      let parsed: URL
      try { parsed = new URL(url) } catch { return }
      const target = new URL(cfg.redirectUri)
      // Exact origin + path match (not a prefix) so a provider-controlled URL like
      // <redirectUri>.evil.example can't satisfy the check.
      if (parsed.origin !== target.origin || parsed.pathname !== target.pathname) return
      // will-redirect and will-navigate can both fire for the same callback URL; once
      // settled, ignore the second so we don't preventDefault on an already-closing window.
      if (settled) return
      preventDefault()
      const error = parsed.searchParams.get('error')
      if (error) {
        const desc = parsed.searchParams.get('error_description') ?? error
        finish(() => reject(new Error(`OAuth error: ${desc}`)))
        return
      }
      const code = parsed.searchParams.get('code')
      const returnedState = parsed.searchParams.get('state')
      if (returnedState !== state) {
        finish(() => reject(new Error('OAuth state mismatch — possible CSRF')))
        return
      }
      if (!code) {
        finish(() => reject(new Error('OAuth response missing authorization code')))
        return
      }
      finish(() => resolve(code))
    }

    win.webContents.on('will-redirect', (event, url) => handleRedirect(url, () => event.preventDefault()))
    win.webContents.on('will-navigate', (event, url) => handleRedirect(url, () => event.preventDefault()))
    win.on('closed', () => {
      if (!settled) {
        settled = true
        reject(new Error('Sign-in window was closed'))
      }
    })

    win.loadURL(authUrl).catch((err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    })
  })
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

// Runs the full browser-window OAuth flow and returns the authenticated profile.
// Must be called from the main process (uses BrowserWindow).
export async function performOAuthFlow(provider: OAuthProvider, cfg: OAuthConfig): Promise<OAuthProfile> {
  const state = randomBytes(16).toString('hex')
  const { verifier, challenge } = pkcePair()
  const code = await authorize(cfg, state, challenge)
  const accessToken = await exchangeCode(cfg, code, verifier)
  return provider === 'github'
    ? fetchGitHubProfile(accessToken)
    : fetchEntraProfile(accessToken)
}
