/**
 * Shared X OAuth2 PKCE helpers for HandlePay claims.
 * Redirect defaults to /claim-handle/callback on the public site URL.
 */
export function handlePayRedirectUri(): string {
  const explicit = (
    process.env.HANDLE_PAY_OAUTH_REDIRECT_URI ||
    process.env.X_OAUTH_REDIRECT_URI ||
    ''
  ).trim()
  if (explicit) return explicit
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'https://www.eve.fun'
  )
    .trim()
    .replace(/\/+$/, '')
    .replace('arcfun.vercel.app', 'www.eve.fun')
  return base ? `${base}/claim-handle/callback` : ''
}

export function handlePayOAuthClientId(): string {
  return (process.env.X_OAUTH_CLIENT_ID || process.env.HANDLE_PAY_X_CLIENT_ID || '').trim()
}

export function handlePayOAuthClientSecret(): string {
  return (process.env.X_OAUTH_CLIENT_SECRET || process.env.HANDLE_PAY_X_CLIENT_SECRET || '').trim()
}

export function handlePayOAuthConfigured(): boolean {
  return Boolean(handlePayOAuthClientId() && handlePayRedirectUri())
}
