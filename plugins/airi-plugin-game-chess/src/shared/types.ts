/**
 * Cross-cutting domain types shared by the Node extension entrypoint, the rules
 * adapters, the WASM engine adapters, and the iframe board UI.
 *
 * Keeping these in one side-effect-free module lets the browser UI and the Node
 * entrypoint agree on the same vocabulary (variant, side, candidate moves)
 * without importing each other's runtime code.
 */

/** Supported board games. `chess` is international chess; `xiangqi` is Chinese chess. */
export type Variant = 'chess' | 'xiangqi'

/** Who Airi plays, or whether both sides are human. */
export type MatchMode = 'vs-airi' | 'two-player'

/**
 * Difficulty band for the local engine when Airi is thinking.
 *
 * It maps to engine search budget and how widely Airi may deviate from the
 * engine's best move during {@link MatchMode} `vs-airi`.
 */
export type Difficulty = 'easy' | 'normal' | 'hard'

/**
 * The two players, named by move order rather than colour so one type covers
 * both games. `first` moves first: White in chess, Red (红) in xiangqi.
 */
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
 * One legal move in a position.
 *
 * `uci` is the engine/transport wire form (e.g. `e2e4`, or `h2e2` on the xiangqi
 * board); `from`/`to` are the board square labels used by the UI; `san` is the
 * human-readable notation shown to the player and described to Airi.
 */
export interface LegalMove {
  from: string
  to: string
  uci: string
  san: string
  /** Promotion piece letter for chess pawn promotions, when applicable. */
  promotion?: string
}

/** A piece occupying a board square, normalized across both rule sets. */
export interface BoardPiece {
  side: Side
  /**
   * Lowercase role letter. Chess: `p n b r q k`. Xiangqi: `p a b r c n k`
   * (pawn, advisor, elephant, rook/chariot, cannon, horse, king/general).
   */
  role: string
}

/** A piece together with the square label it sits on. */
export interface PlacedPiece {
  square: string
  piece: BoardPiece
}

/**
 * One engine candidate move with its evaluation, as produced by a MultiPV search.
 *
 * Exactly one of `scoreCp` / `mate` is meaningful per candidate: `scoreCp` is the
 * centipawn evaluation from the side-to-move's perspective; `mate` is the number
 * of moves to mate (positive = side-to-move mates, negative = gets mated).
 */
export interface EngineCandidate {
  uci: string
  san: string
  /** 1-based MultiPV rank; rank 1 is the engine's preferred move. */
  rank: number
  scoreCp?: number
  mate?: number
}

/** Result of analysing one position: the best move plus ranked candidates. */
export interface EngineAnalysis {
  best: string
  candidates: EngineCandidate[]
}
