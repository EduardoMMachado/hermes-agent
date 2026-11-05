import { Box, Text } from '@hermes/ink'
import { mix } from '@hermes/shared/color'

import type { Theme } from '../theme.js'

export interface StickyUserPromptProps {
  onJump: () => void
  t: Theme
  text: string
}

/** Outside the transcript viewport: preserves the latest request as reading
 * context, without repeating it while its original row is on screen. */
export function StickyUserPrompt({ onJump, t, text }: StickyUserPromptProps) {
  if (!text) {
    return null
  }

  return (
    <Box
      backgroundColor={mix(t.color.completionBg, t.color.primary, 0.14)}
      flexDirection="column"
      flexShrink={0}
      onClick={onJump}
      paddingX={1}
    >
      <Text bold color={t.color.accent} wrap="truncate-end">
        ↑ SUA MENSAGEM ACIMA · clique para ver
      </Text>
      <Text color={t.color.label} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
}
