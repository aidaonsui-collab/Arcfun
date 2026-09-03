/**
 * Resolve `@/` to the repo root, and extensionless relative imports to `.ts`,
 * so the indexer daemon can import app TS with
 * `node --experimental-strip-types --import ./scripts/alias-register.mjs`.
 */
import { existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')

function pick(base) {
  if (existsSync(base) && !base.endsWith('/')) return base
  for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
    if (existsSync(base + ext)) return base + ext
  }
  if (existsSync(`${base}/index.ts`)) return `${base}/index.ts`
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server' || specifier === 'next/server.js') {
    return nextResolve(pathToFileURL(resolvePath(root, 'scripts/next-server-stub.mjs')).href, context)
  }
  if (specifier.startsWith('@/')) {
    const file = pick(resolvePath(root, specifier.slice(2))) || `${resolvePath(root, specifier.slice(2))}.ts`
    return nextResolve(pathToFileURL(file).href, context)
  }
  if (specifier.startsWith('.') && context.parentURL) {
    const parent = fileURLToPath(context.parentURL)
    const file = pick(resolvePath(dirname(parent), specifier))
    if (file) return nextResolve(pathToFileURL(file).href, context)
  }
  return nextResolve(specifier, context)
}
