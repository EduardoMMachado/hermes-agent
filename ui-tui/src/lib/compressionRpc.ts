// Same bounded answer budget as hermes_cli.gateway_client.COMPRESS_RPC_TIMEOUT and Desktop:
// the compute-host bridge waits at most 630s (600s compression ceiling + 30s handoff).
// This is a client wait, not a cancellation deadline for a canonical owner's shielded mutation.
export const COMPRESSION_RPC_TIMEOUT_MS = 660_000

export function isCompressionRequest(method: string, params: Record<string, unknown>): boolean {
  return method === 'session.compress' || (method === 'session.mutate' && params.operation === 'compress')
}
