import { Box, Text } from '@hermes/ink'
import { useEffect, useRef, useState } from 'react'

import { writeClipboardText } from '../lib/clipboard.js'
import { writeOsc52Clipboard } from '../lib/osc52.js'
import { isRemoteShellSession } from '../lib/terminalSetup.js'
import type { Theme } from '../theme.js'

/** Same transport as `/copy`: OSC52 over SSH, native clipboard locally with
 *  OSC52 as the fallback. Resolves true once one path accepted the text. */
export async function copyCodeText(text: string): Promise<boolean> {
  if (isRemoteShellSession(process.env)) {
    return writeOsc52Clipboard(text)
  }

  try {
    if (await writeClipboardText(text)) {
      return true
    }
  } catch {
    // Native clipboard unavailable — fall through to OSC52.
  }

  return writeOsc52Clipboard(text)
}

const FEEDBACK_MS = 1800

/** Clickable `⧉ copy` label for a fenced code block; flips to `✓ copied`. */
export function CodeCopyButton({ t, text }: { t: Theme; text: string }) {
  const [state, setState] = useState<'copied' | 'failed' | 'idle'>('idle')
  const timer = useRef<null | ReturnType<typeof setTimeout>>(null)

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    []
  )

  const onClick = () => {
    void copyCodeText(text).then(ok => {
      setState(ok ? 'copied' : 'failed')

      if (timer.current) {
        clearTimeout(timer.current)
      }

      timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS)
    })
  }

  const label = state === 'copied' ? '✓ copiado' : state === 'failed' ? '✗ falhou' : '⧉ copiar'
  const color = state === 'copied' ? t.color.ok : state === 'failed' ? t.color.error : t.color.accent

  return (
    <Box flexShrink={0} onClick={onClick}>
      <Text color={color}>{label}</Text>
    </Box>
  )
}
