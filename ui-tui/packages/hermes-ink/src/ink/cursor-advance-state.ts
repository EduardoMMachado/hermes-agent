import type { CursorDeclaration } from './components/CursorDeclarationContext.js'

interface CursorPosition {
  x: number
  y: number
}

interface CursorAdvanceState {
  alternate: boolean
  declaration: CursorDeclaration | null
  painted: CursorDeclaration | null
  parked: CursorPosition | null
  frameCursor: CursorPosition
}

export function hasPaintedCursor(
  parked: CursorPosition | null,
  painted: CursorDeclaration | null,
  declared: CursorDeclaration | null
): boolean {
  return parked !== null && painted !== null && declared !== null &&
    painted.node === declared.node && painted.relativeX === declared.relativeX && painted.relativeY === declared.relativeY
}

export function getPaintedCursorDeclaration(
  declaration: CursorDeclaration | null,
  target: CursorPosition,
  alternate: boolean,
  width: number,
  rows: number
): CursorDeclaration | null {
  // Alternate-screen CUP clamps out-of-viewport coordinates, unlike logical main-screen scrollback.
  return !alternate || (target.x >= 0 && target.x < width && target.y >= 0 && target.y < rows) ? declaration : null
}

export function advanceCursorBaseline(state: CursorAdvanceState, dx: number, dy: number) {
  const wasReady = hasPaintedCursor(state.parked, state.painted, state.declaration)
  let parked = state.parked
  let declaration = state.declaration

  if (dx === 0 && dy === 0) {
    return { parked, declaration, painted: state.painted }
  }

  // Main-screen relative diffs must undo the raw write from its actual physical position.
  // Alternate-screen diffs start with CSI H, but still consult the caret declaration below.
  if (!state.alternate) {
    const from = parked ?? state.frameCursor
    parked = { x: from.x + dx, y: from.y + dy }
  }

  if (declaration !== null) {
    declaration = {
      node: declaration.node,
      relativeX: declaration.relativeX + dx,
      relativeY: declaration.relativeY + dy
    }
  }

  // A raw write advances an already-painted baseline, never a declaration still awaiting paint.
  return { parked, declaration, painted: wasReady ? declaration : state.painted }
}
