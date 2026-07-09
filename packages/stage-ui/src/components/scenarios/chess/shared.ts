/**
 * Shared, framework-free domain types for the in-app chess / xiangqi scenario.
 *
 * Both the international-chess and Chinese-chess boards run on the same local
 * WASM stack (ffish rules + Fairy-Stockfish engine), so one vocabulary covers
 * both games.
 */

/**
 * Default coach persona / instructions — the user-editable part of the chat
 * prompt. The live game state (variant, side, FEN, move history, side to move)
 * is appended automatically at ask time, so a custom persona never needs to
 * include it. Lives here (side-effect-free) so the store can default to it
 * without pulling the board component into its import graph.
 */
export const DEFAULT_COACH_PROMPT = '你是 Airi —— Hoshi 的私人下棋教练，同时也是她这盘棋的对手。和你说话的人始终是 Hoshi（你的学生兼玩家）：绝不要把 Hoshi 当成 Airi，也不要自称 Hoshi，你回答时就是教练 Airi 本人。请用中文、以温暖鼓励的教练口吻、简洁(2-4 句)回答 Hoshi 的问题：讲清思路、给出可行的下一步建议、指出战术机会或失误。不要罗列长串引擎着法，也不要编造不存在的棋子。'

/** Supported board games. `chess` is international chess; `xiangqi` is Chinese chess. */
export type Variant = 'chess' | 'xiangqi'

/** Whether the opponent is the local engine/Airi or a second human. */
export type MatchMode = 'vs-airi' | 'two-player'

/** The two players by move order. `first` moves first: White (chess) / Red (xiangqi). */
export type Side = 'first' | 'second'

/** Returns the side that does not move next. */
export function opponentOf(side: Side): Side {
  return side === 'first' ? 'second' : 'first'
}

/** Human-facing colour label for a side, localized per variant. */
export function sideLabel(variant: Variant, side: Side): string {
  if (variant === 'xiangqi') {
    return side === 'first' ? '红' : '黑'
  }
  return side === 'first' ? 'White' : 'Black'
}

/**
 * One legal move. `uci` is the engine wire form (`e2e4`, `h2e2`); `from`/`to`
 * are board square labels used by the UI; `san` is human-readable notation.
 */
export interface LegalMove {
  from: string
  to: string
  uci: string
  san: string
  promotion?: string
}

/** A piece on the board, normalized across both rule sets. */
export interface BoardPiece {
  side: Side
  /** Lowercase role letter (chess: p n b r q k; xiangqi: p a b r c n k). */
  role: string
}

/** A piece together with the square it occupies. */
export interface PlacedPiece {
  square: string
  piece: BoardPiece
}

/**
 * One engine candidate move with its evaluation from the mover's perspective.
 * Exactly one of `scoreCp` / `mate` is meaningful.
 */
export interface EngineCandidate {
  uci: string
  san: string
  /** 1-based MultiPV rank; rank 1 is the engine's preferred move. */
  rank: number
  scoreCp?: number
  mate?: number
}

/** Outcome of asking the move source (engine or Airi) for a move. */
export interface MoveDecision {
  /** UCI of the move to play. */
  uci: string
  /** Optional commentary to surface alongside the move. */
  commentary?: string
}

/** Human-readable evaluation for a candidate, from the mover's perspective. */
export function formatEvaluation(candidate: Pick<EngineCandidate, 'scoreCp' | 'mate'>): string {
  if (candidate.mate != null) {
    return candidate.mate >= 0 ? `mate in ${candidate.mate}` : `mated in ${-candidate.mate}`
  }
  if (candidate.scoreCp != null) {
    const pawns = candidate.scoreCp / 100
    const sign = pawns > 0 ? '+' : ''
    return `${sign}${pawns.toFixed(1)}`
  }
  return 'unclear'
}
