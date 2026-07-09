import type { EngineAdapter } from '../../engines'
import type { RulesAdapter } from '../../rules'
import type { BoardPiece, Difficulty, EngineCandidate, MatchMode, Side, Variant } from '../../shared/types'
import type { AiriBridge } from './use-airi-bridge'

import { errorMessageFrom } from '@moeru/std'
import { computed, ref, shallowRef } from 'vue'

import { createEngine, difficultyProfile } from '../../engines'
import { createRules } from '../../rules'
import { opponentOf, sideLabel } from '../../shared/types'

/** Lifecycle of one board session. */
export type GamePhase = 'setup' | 'playing' | 'over'

/**
 * Orchestrates a board session: it owns the rules adapter, the local engine, the
 * turn loop, and the Airi move-selection round trip.
 *
 * The board is rendered from the very first load (showing the starting position)
 * so the setup panel and the grid coexist; {@link UseGame.startGame} begins play.
 */
export function useGame(bridge: AiriBridge) {
  // Match setup, bound to the setup panel.
  const variant = ref<Variant>('chess')
  const mode = ref<MatchMode>('vs-airi')
  // Default: the human plays first (White/Red), Airi replies as the second side.
  const airiSide = ref<Side>('second')
  const difficulty = ref<Difficulty>('normal')

  const phase = ref<GamePhase>('setup')
  const thinking = ref(false)
  const commentary = ref('')
  const errorMessage = ref('')

  // Non-reactive engine/rules handles; reactive board state is mirrored below.
  let rules: RulesAdapter | undefined
  let engine: EngineAdapter | undefined

  const cols = ref(8)
  const rows = ref(8)
  const squareAt = shallowRef<(col: number, row: number) => string>((c, r) => `${c},${r}`)
  const pieces = ref<Record<string, BoardPiece>>({})
  const turn = ref<Side>('first')
  const inCheck = ref(false)
  const result = ref('*')
  const selected = ref<string>('')
  const targets = ref<Set<string>>(new Set())
  const lastMove = ref<{ from: string, to: string } | undefined>()

  /** Mirrors the current rules-adapter position into the reactive board state. */
  function refresh() {
    if (!rules) {
      return
    }
    pieces.value = Object.fromEntries(rules.pieces().map(placed => [placed.square, placed.piece]))
    turn.value = rules.turn()
    inCheck.value = rules.isCheck()
    result.value = rules.result()
  }

  /** (Re)creates the rules adapter for the active variant and renders its start. */
  async function loadRules() {
    rules?.dispose()
    rules = await createRules(variant.value)
    cols.value = rules.cols
    rows.value = rules.rows
    squareAt.value = rules.squareAt
    selected.value = ''
    targets.value = new Set()
    lastMove.value = undefined
    refresh()
  }

  const statusText = computed(() => {
    if (phase.value === 'setup') {
      return 'Match Setup'
    }
    if (phase.value === 'over') {
      if (result.value === '1/2-1/2') {
        return 'Draw'
      }
      const winner: Side = result.value === '1-0' ? 'first' : 'second'
      return `${sideLabel(variant.value, winner)} wins`
    }
    const mover = `${sideLabel(variant.value, turn.value)} to move`
    return inCheck.value ? `${mover} — check!` : mover
  })

  const airiThinkingLabel = computed(() => (thinking.value ? 'Airi is thinking…' : ''))

  function isAiriTurn(): boolean {
    return mode.value === 'vs-airi' && turn.value === airiSide.value
  }

  /** Enriches engine candidates with SAN from the current legal move list. */
  function enrichCandidates(rawCandidates: { uci: string, rank: number, scoreCp?: number, mate?: number }[]): EngineCandidate[] {
    const sanByUci = new Map(rules!.legalMoves().map(move => [move.uci, move.san]))
    return rawCandidates.map(candidate => ({
      ...candidate,
      san: sanByUci.get(candidate.uci) ?? candidate.uci,
    }))
  }

  async function playAiriMove() {
    if (!rules || !engine || thinking.value) {
      return
    }
    thinking.value = true
    selected.value = ''
    targets.value = new Set()
    try {
      const profile = difficultyProfile(difficulty.value)
      const fen = rules.fen()
      const analysis = await engine.analyze(fen, { multiPv: profile.candidates, movetimeMs: profile.movetimeMs })
      const candidates = enrichCandidates(analysis.candidates)

      const decision = await bridge.requestMove({
        variant: variant.value,
        airiSide: airiSide.value,
        fen,
        candidates,
        fallbackResponseText: variant.value === 'xiangqi' ? '该我了，走这一步。' : 'My turn — here we go.',
      })

      const move = rules.move(decision.uci || analysis.best)
      if (move) {
        lastMove.value = { from: move.from, to: move.to }
        commentary.value = decision.commentary
      }
      refresh()
      if (rules.isGameOver()) {
        phase.value = 'over'
      }
    }
    catch (error) {
      errorMessage.value = errorMessageFrom(error) ?? 'Airi could not make a move.'
    }
    finally {
      thinking.value = false
    }
  }

  function selectableBy(square: string): boolean {
    return pieces.value[square]?.side === turn.value
  }

  /** Handles a click on a board square during play. */
  function onSquareClick(square: string) {
    if (!rules || phase.value !== 'playing' || thinking.value || isAiriTurn()) {
      return
    }

    if (selected.value && targets.value.has(square)) {
      const move = rules.move({ from: selected.value, to: square })
      selected.value = ''
      targets.value = new Set()
      if (move) {
        lastMove.value = { from: move.from, to: move.to }
        commentary.value = ''
        refresh()
        if (rules.isGameOver()) {
          phase.value = 'over'
        }
        else if (isAiriTurn()) {
          void playAiriMove()
        }
      }
      return
    }

    if (selectableBy(square)) {
      selected.value = square
      targets.value = new Set(rules.legalMovesFrom(square).map(move => move.to))
      return
    }

    selected.value = ''
    targets.value = new Set()
  }

  /** Starts a new match with the selected settings. */
  async function startGame() {
    errorMessage.value = ''
    commentary.value = ''
    await loadRules()

    if (mode.value === 'vs-airi') {
      try {
        engine?.dispose()
        engine = await createEngine(variant.value)
      }
      catch (error) {
        errorMessage.value = errorMessageFrom(error) ?? 'Failed to start the engine.'
        return
      }
    }

    phase.value = 'playing'
    if (isAiriTurn()) {
      void playAiriMove()
    }
  }

  /** Returns to the setup panel and releases the engine. */
  function restart() {
    engine?.dispose()
    engine = undefined
    phase.value = 'setup'
    commentary.value = ''
    void loadRules()
  }

  // Render the default board immediately; re-render when the variant changes in setup.
  void loadRules()

  function changeVariant(next: Variant) {
    if (phase.value !== 'setup') {
      return
    }
    variant.value = next
    void loadRules()
  }

  return {
    variant,
    mode,
    airiSide,
    difficulty,
    phase,
    thinking,
    commentary,
    errorMessage,
    cols,
    rows,
    squareAt,
    pieces,
    turn,
    inCheck,
    selected,
    targets,
    lastMove,
    statusText,
    airiThinkingLabel,
    opponentLabel: computed(() => sideLabel(variant.value, opponentOf(airiSide.value))),
    onSquareClick,
    startGame,
    restart,
    changeVariant,
  }
}

export type UseGame = ReturnType<typeof useGame>
