import { Box, ScrollBox, type ScrollBoxHandle, Text, useStdout, wrapAnsi } from '@hermes/ink'
import { mix } from '@hermes/shared/color'
import { useEffect, useRef } from 'react'

import type { Theme } from '../theme.js'

import { fmtMsgTimestamp } from './messageLine.js'

export interface StickyUserPromptProps {
  cols: number
  createdAt?: number
  onJump: () => void
  t: Theme
  text: string
  timestamps?: boolean
}

/** Outside the transcript viewport: preserves the latest request as reading
 * context, without repeating it while its original row is on screen. */
export function StickyUserPrompt({ cols, createdAt, onJump, t, text, timestamps }: StickyUserPromptProps) {
  const { stdout } = useStdout()
  const scrollRef = useRef<null | ScrollBoxHandle>(null)
  const rows = wrapAnsi(text, Math.max(1, cols - 2), { hard: true, trim: false }).split('\n').length
  const visibleRows = Math.min(rows, Math.max(1, Math.floor((stdout?.rows ?? 24) * 0.4)))
  const overflow = rows > visibleRows

  useEffect(() => { scrollRef.current?.scrollTo(0) }, [text])

  if (!text) {
    return null
  }

  return (
    <Box
      backgroundColor={mix(t.color.completionBg, t.color.primary, 0.14)}
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
    >
      <Box flexDirection="column" onClick={onJump}>
        <Text bold color={t.color.accent} wrap="truncate-end">
          ↑ SUA MENSAGEM ACIMA · clique para ver
        </Text>
        {timestamps && <Text color={t.color.muted}>{fmtMsgTimestamp(createdAt) ?? '[horário não registrado]'}</Text>}
      </Box>
      <ScrollBox flexDirection="column" height={visibleRows} ref={scrollRef} stickyScroll={false}>
        <Text color={t.color.label}>{text}</Text>
      </ScrollBox>
      {overflow && (
        <Box flexDirection="row">
          <Box onClick={() => scrollRef.current?.scrollBy(-5)}><Text color={t.color.accent}> ↑ </Text></Box>
          <Text color={t.color.muted}>rolar mensagem completa</Text>
          <Box onClick={() => scrollRef.current?.scrollBy(5)}><Text color={t.color.accent}> ↓ </Text></Box>
        </Box>
      )}
    </Box>
  )
}
