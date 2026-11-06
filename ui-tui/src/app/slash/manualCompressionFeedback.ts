import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'

import type { SessionCompressResponse } from '../../gatewayTypes.js'
import { t } from '../../i18n/runtime.js'
import { rpcErrorMessage } from '../../lib/rpc.js'
import type { SlashHandlerContext } from '../interfaces.js'
import { captureDestination, type SubmissionDestination } from '../submissionDestination.js'

import type { SlashRunCtx } from './types.js'

interface CompressionFlight {
  uncertain: boolean
}
export class CompressionStillRunning extends Error {}

/** These replies changed no transcript. In particular a preview/abort must never get a success tick. */
export function reportUncommittedCompression(result: SessionCompressResponse, ctx: SlashRunCtx): boolean {
  if (!(
    result.status === 'preview' ||
    result.status === 'noop' ||
    result.compressed === false ||
    result.status === 'aborted' ||
    result.summary?.aborted ||
    result.summary?.noop
  )) {
    return false
  }

  const summary = result.summary
  ctx.transcript.sys(
    result.host_ack?.output || summary?.headline || result.message || t('slashCmd.session.compress.nothing')
  )

  for (const line of [summary?.token_line, summary?.note]) {
    if (line) {
      ctx.transcript.sys(`  ${line}`)
    }
  }

  return true
}

const flights = new WeakMap<object, Map<string, CompressionFlight>>()

const keyFor = (destination: SubmissionDestination) =>
  JSON.stringify([destination.profileHome, destination.ownerHome, destination.profile, destination.sid])

/** Check before incrementing the slash flight: a duplicate must not invalidate the first reply. */
export function compressionAlreadyWaiting(ctx: SlashHandlerContext, destination: SubmissionDestination): boolean {
  const flight = flights.get(ctx.gateway.gw)?.get(keyFor(destination))

  if (!flight) {
    return false
  }

  ctx.transcript.sys(
    t(flight.uncertain ? 'slashCmd.session.compress.unknownDuplicate' : 'slashCmd.session.compress.alreadyWaiting')
  )

  return true
}

/** Local elapsed waiting, never provider progress. Do not set chat `busy`: that owns turn/abort semantics. */
export function runWithCompressionFeedback(ctx: SlashRunCtx, run: (owned: SlashRunCtx) => unknown): void {
  const gw = ctx.gateway.gw
  let sessions = flights.get(gw)

  if (!sessions) {
    sessions = new Map()
    flights.set(gw, sessions)
  }

  const key = keyFor(captureDestination())
  const flight = { uncertain: false }
  sessions.set(key, flight)
  const started = performance.now()
  ctx.transcript.sys(t('slashCmd.session.compress.waiting', '0'))

  const timer = setInterval(() => {
    if (ctx.stale()) {
      clearInterval(timer)

      return
    }

    ctx.transcript.sys(t('slashCmd.session.compress.waiting', String(Math.floor((performance.now() - started) / 1000))))
  }, 30_000)

  timer.unref?.()

  const guardedErr = (error: unknown) => {
    // A lost legacy reply has no receipt to query safely. Keep its per-session claim rather
    // than issuing another compression. Canonical explicit retries retain the original CAS/id.
    const definitive =
      error instanceof JsonRpcGatewayError || Boolean((error as { data?: { reason?: string } })?.data?.reason)

    flight.uncertain = !gw.isCanonical && !definitive

    if (!ctx.stale()) {
      ctx.transcript.sys(
        error instanceof CompressionStillRunning
          ? error.message || t('slashCmd.session.compress.stillRunning')
          : `error: ${definitive ? rpcErrorMessage(error) : t('slashCmd.session.compress.outcomeUnknown', String(Math.floor((performance.now() - started) / 1000)))}`
      )
    }

    gw.recordLog?.(`[compress] ${error instanceof Error ? error.message : String(error)}`)
  }

  void (async () => run({ ...ctx, guardedErr }))()
    .catch(guardedErr)
    .finally(() => {
      clearInterval(timer)

      if (!flight.uncertain) {
        sessions.delete(key)
      }
    })
}
