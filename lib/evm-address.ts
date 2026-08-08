const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/

/** Cheap shape check for an EVM address (no checksum validation). */
export function isPlausibleEvmAddress(s: string): boolean {
  return typeof s === 'string' && EVM_ADDR_RE.test(s)
}
