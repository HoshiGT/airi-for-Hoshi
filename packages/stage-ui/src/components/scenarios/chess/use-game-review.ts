import type { GameReview, PositionAnalysis, ReviewedPly } from './review'
import type { BoardPiece, Variant } from './shared'
import type { PlyRecord } from './use-chess-game'

import { errorMessageFrom } from '@moeru/std'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'

import { deriveReview, moverEvalCp } from './review'
import { createRules } from './rules'
import { createGameEngine } from './server-engine'

/** Narrow view of the finished game a review needs; getters read live state. */
export interface ReviewGameView {
  variant: () => Variant
  plies: () => PlyRecord[]
  /** Game result string ('1-0' / '0-1' / '1/2-1/2'); only read once finished. */
  result: () => string
}

/**
 * Post-game review runner: replays the finished game on a fresh rules board,
 * analyzes every position with the strongest reachable engine (server-side
 * native engine when available, the built-in search otherwise), grades each
 * move via {@link deriveReview}, and keeps per-position piece snapshots so the
 * board can step through the game.
 *
 * One review belongs to one finished game: call {@link reset} when a new match
 * starts — it also cancels an in-flight analysis (the loop re-checks its run
 * token after every await and stops silently when it went stale).
 */
export function useGameReview(game: ReviewGameView) {
  const status = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const progress = ref({ done: 0, total: 0 })
  const error = ref('')
  const review = shallowRef<GameReview>()
  // pieces-by-square snapshots for positions 0 (start) .. N (final).
  const snapshots = shallowRef<Record<string, BoardPiece>[]>([])
  // Viewed position: -1 = the starting position, k ≥ 0 = after ply k.
  const selectedPly = ref(-1)

  let runToken = 0

  const totalPlies = computed(() => review.value?.plies.length ?? 0)
  /** The reviewed move at the viewed position; undefined at the start position. */
  const current = computed<ReviewedPly | undefined>(() =>
    selectedPly.value >= 0 ? review.value?.plies[selectedPly.value] : undefined)

  // Board overrides for ChessGame: only meaningful once the review is done.
  const boardPieces = computed(() =>
    status.value === 'done' ? snapshots.value[selectedPly.value + 1] : undefined)
  const boardLastMove = computed(() =>
    current.value ? { from: current.value.from, to: current.value.to } : undefined)

  function select(index: number) {
    selectedPly.value = Math.max(-1, Math.min(index, totalPlies.value - 1))
  }

  /** Analyzes the finished game; safe to call once per game (re-runs are no-ops while running). */
  async function start() {
    const plies = game.plies()
    if (status.value === 'running' || plies.length === 0) {
      return
    }
    const token = ++runToken
    status.value = 'running'
    progress.value = { done: 0, total: plies.length }
    error.value = ''

    try {
      const variant = game.variant()
      const engine = await createGameEngine(variant)
      const rules = await createRules(variant)
      try {
        const positions: PositionAnalysis[] = []
        const piecesNow = () => Object.fromEntries(rules.pieces().map(placed => [placed.square, placed.piece]))
        const positionSnapshots: Record<string, BoardPiece>[] = [piecesNow()]

        for (let index = 0; index < plies.length; index++) {
          // SAN naming must come from the position BEFORE the engine call uses it.
          const sanByUci = new Map(rules.legalMoves().map(move => [move.uci, move.san]))
          const analysis = await engine.analyze(rules.fen())
          if (token !== runToken) {
            return
          }
          const top = analysis.candidates[0]
          positions.push({
            evalCp: top ? moverEvalCp(top) : 0,
            bestUci: analysis.best,
            bestSan: sanByUci.get(analysis.best) ?? analysis.best,
          })
          if (!rules.move(plies[index].uci)) {
            throw new Error(`复盘重放失败：第 ${index + 1} 步 ${plies[index].san}`)
          }
          positionSnapshots.push(piecesNow())
          progress.value = { done: index + 1, total: plies.length }
          // Yield a frame so the progress paints — the built-in engine searches
          // synchronously on this thread.
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }

        if (token !== runToken) {
          return
        }
        review.value = deriveReview(plies, positions, game.result())
        snapshots.value = positionSnapshots
        // Start the walkthrough from the opening, chess.com style.
        selectedPly.value = -1
        status.value = 'done'
      }
      finally {
        engine.dispose()
        rules.dispose()
      }
    }
    catch (cause) {
      if (token === runToken) {
        error.value = errorMessageFrom(cause) ?? '复盘分析失败'
        status.value = 'error'
      }
    }
  }

  // Leaving the page mid-analysis: stale the token so the loop stops at its
  // next checkpoint instead of analyzing a game nobody is watching.
  onScopeDispose(() => {
    runToken++
  })

  /** Drops the review (and cancels an in-flight run) — call on New Match. */
  function reset() {
    runToken++
    status.value = 'idle'
    progress.value = { done: 0, total: 0 }
    error.value = ''
    review.value = undefined
    snapshots.value = []
    selectedPly.value = -1
  }

  return {
    status,
    progress,
    error,
    review,
    selectedPly,
    totalPlies,
    current,
    boardPieces,
    boardLastMove,
    start,
    reset,
    select,
    next: () => select(selectedPly.value + 1),
    prev: () => select(selectedPly.value - 1),
  }
}

export type UseGameReview = ReturnType<typeof useGameReview>
