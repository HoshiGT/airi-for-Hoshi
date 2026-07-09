import type { PlayerLevel } from './move-policy'
import type { RulesAdapter } from './rules'
import type { GameEngine } from './server-engine'
import type { BoardPiece, EngineCandidate, MatchMode, MoveDecision, Side, Variant } from './shared'

import { errorMessageFrom } from '@moeru/std'
import { computed, nextTick, ref, shallowRef } from 'vue'

import { selectMove } from './move-policy'
import { createRules } from './rules'
import { createGameEngine } from './server-engine'
import { formatEvaluation, sideLabel } from './shared'
import { XIANGQI_PIECE_NAMES } from './xiangqi-notation'

/** Lifecycle of one board session. */
export type GamePhase = 'setup' | 'playing' | 'over'

/** Context handed to a move source when it is the opponent's turn. */
export interface OpponentTurnInput {
  variant: Variant
  airiSide: Side
  fen: string
  /** Rank-ordered, SAN-enriched engine candidates (rank 1 is best). */
  candidates: EngineCandidate[]
}

/** Optional move source; when omitted the engine plays its own best move. */
export type RequestAiriMove = (input: OpponentTurnInput) => Promise<MoveDecision>

/** One played move as recorded for the move list and post-game review. */
export interface PlyRecord {
  uci: string
  san: string
  from: string
  to: string
}

// Bounds for Airi's "thinking" pause before a move. The budget floats within
// this range per move so the pace never lands on a fixed beat.
const THINK_MIN_MS = 500
const THINK_MAX_MS = 2200

/**
 * A randomized think budget (ms) for one move, so Airi's pace feels human: it
 * leans longer when the choice is close (a hard decision) and shorter when one
 * move clearly stands out, then mixes in randomness so no two moves match.
 *
 * Difficulty comes from the eval gap between the best and second-best candidate:
 * a small gap (~equal moves) reads as a hard call, a large gap as an obvious one.
 */
function thinkBudgetMs(candidates: EngineCandidate[]): number {
  let difficulty = 0.5
  if (candidates.length >= 2 && candidates[0].scoreCp != null && candidates[1].scoreCp != null) {
    const gap = Math.abs(candidates[0].scoreCp - candidates[1].scoreCp)
    // 0cp gap → 1 (agonize); ≥300cp gap → 0 (snap it out).
    difficulty = 1 - Math.min(gap, 300) / 300
  }
  // Half difficulty-driven, half pure randomness, scaled across the range.
  const weight = 0.5 * difficulty + 0.5 * Math.random()
  return Math.round(THINK_MIN_MS + weight * (THINK_MAX_MS - THINK_MIN_MS))
}

// Chinese piece names per variant+side for the coach's board description. A weak
// local model can't reliably parse FEN, so the coach is given named pieces with
// their squares instead. Side labels carry the colour, so chess names are shared;
// xiangqi names come from the notation module so move names and the board
// description always agree.
const PIECE_NAMES: Record<Variant, Record<Side, Record<string, string>>> = {
  chess: {
    first: { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' },
    second: { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' },
  },
  xiangqi: XIANGQI_PIECE_NAMES,
}

/**
 * Orchestrates an in-app board session: it owns the rules adapter, the local
 * search engine, the turn loop, and (optionally) Airi's move selection.
 *
 * The board renders from first load (the starting position), so the setup panel
 * and the grid coexist; {@link startGame} begins play. When `requestAiriMove` is
 * provided it chooses the opponent move among the engine's candidates; otherwise
 * the engine's best move is played.
 */
export function useChessGame(options: { requestAiriMove?: RequestAiriMove } = {}) {
  const variant = ref<Variant>('chess')
  const mode = ref<MatchMode>('vs-airi')
  // Default: the human plays first (White/Red), the opponent replies second.
  const airiSide = ref<Side>('second')
  const playerLevel = ref<PlayerLevel>('amateur')

  const phase = ref<GamePhase>('setup')
  const thinking = ref(false)
  const errorMessage = ref('')

  // Non-reactive engine/rules handles; reactive board state is mirrored below.
  let rules: RulesAdapter | undefined
  let engine: GameEngine | undefined
  // Where the opponent's engine runs: the server-side native engine (Stockfish
  // / Pikafish) or the built-in search. Mirrored after every analyze because
  // the adapter can degrade to 'local' mid-game if the service goes away.
  const engineSource = ref<'server' | 'local' | ''>('')

  const cols = ref(8)
  const rows = ref(8)
  const squareAt = shallowRef<(col: number, row: number) => string>((c, r) => `${c},${r}`)
  const pieces = ref<Record<string, BoardPiece>>({})
  const turn = ref<Side>('first')
  const inCheck = ref(false)
  const result = ref('*')
  const selected = ref('')
  const targets = ref<Set<string>>(new Set())
  const lastMove = ref<{ from: string, to: string }>()
  // Every played move in order; the SAN history and the post-game review both
  // derive from this single record.
  const plies = ref<PlyRecord[]>([])
  const history = computed(() => plies.value.map(ply => ply.san))

  /** Appends a just-applied move to the game record and the board highlights. */
  function recordMove(move: { uci: string, san: string, from: string, to: string }) {
    lastMove.value = { from: move.from, to: move.to }
    plies.value = [...plies.value, { uci: move.uci, san: move.san, from: move.from, to: move.to }]
  }

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
    plies.value = []
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

  const thinkingLabel = computed(() => (thinking.value ? 'Thinking…' : ''))

  function isOpponentTurn(): boolean {
    return mode.value === 'vs-airi' && turn.value === airiSide.value
  }

  /** Enriches engine candidates with SAN from the current legal move list. */
  function enrichCandidates(raw: { uci: string, rank: number, scoreCp?: number, mate?: number }[]): EngineCandidate[] {
    const sanByUci = new Map(rules!.legalMoves().map(move => [move.uci, move.san]))
    return raw.map(candidate => ({ ...candidate, san: sanByUci.get(candidate.uci) ?? candidate.uci }))
  }

  async function playOpponentMove() {
    if (!rules || !engine || thinking.value) {
      return
    }
    thinking.value = true
    selected.value = ''
    targets.value = new Set()
    const startedAt = Date.now()
    try {
      // The engine search is synchronous and blocks the main thread, which would
      // freeze the human's just-made slide if it ran in the same tick. Yield past
      // a paint first (DOM update via nextTick, then one rendered frame) so that
      // slide hands off to the compositor and keeps animating during the search.
      await nextTick()
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

      const positionFen = rules.fen()
      const analysis = await engine.analyze(positionFen)
      // The adapter may have degraded server → local during this analyze.
      engineSource.value = engine.source
      const candidates = enrichCandidates(analysis.candidates)

      let decision: MoveDecision
      if (options.requestAiriMove) {
        decision = await options.requestAiriMove({ variant: variant.value, airiSide: airiSide.value, fen: positionFen, candidates })
      }
      else {
        // No external chooser: the adaptive policy picks how hard Airi plays from
        // the player's declared level (eases toward weaker moves at low levels).
        const choice = selectMove(candidates, playerLevel.value)
        decision = choice ? { uci: choice.uci } : { uci: analysis.best }
      }

      // Pad a fast engine reply up to this move's (floating) think budget so the
      // move doesn't snap in; a slow search that already exceeded it just plays.
      const budget = thinkBudgetMs(candidates)
      const elapsed = Date.now() - startedAt
      if (elapsed < budget) {
        await new Promise(resolve => setTimeout(resolve, budget - elapsed))
      }

      const move = rules.move(decision.uci || analysis.best)
      if (move) {
        recordMove(move)
      }
      refresh()
      if (rules.isGameOver()) {
        phase.value = 'over'
      }
    }
    catch (error) {
      errorMessage.value = errorMessageFrom(error) ?? 'The opponent could not move.'
    }
    finally {
      thinking.value = false
    }
  }

  /**
   * Runs the engine on the current position and formats a short hint (eval + top
   * moves in SAN) for the coach chat — so the weak local model can advise from
   * the strong engine's analysis instead of its own chess sense. Returns
   * undefined when no engine is loaded (setup / two-player) or on any failure,
   * in which case the coach simply gives advice without engine guidance.
   */
  async function analyzeForCoach(): Promise<string | undefined> {
    if (!rules || !engine) {
      return undefined
    }
    try {
      const analysis = await engine.analyze(rules.fen())
      const enriched = enrichCandidates(analysis.candidates)
      if (enriched.length === 0) {
        return undefined
      }
      const top = enriched.slice(0, 3).map(candidate => `${candidate.san} (${formatEvaluation(candidate)})`).join('、')
      return `引擎评估 ${formatEvaluation(enriched[0])}（从轮到走的一方看，正数=该方占优）；推荐着法：${top}`
    }
    catch {
      return undefined
    }
  }

  /**
   * Renders the current position as plain text for the coach: a coordinate-
   * labelled ASCII grid (uppercase = first side, lowercase = second) plus an
   * explicit per-side piece list with squares. FEN is unreadable to weak local
   * models, so this is what lets the coach actually "see" what is where.
   */
  function describeBoard(): string {
    if (!rules) {
      return ''
    }
    const v = variant.value
    const placed = rules.pieces()
    const bySquare = new Map(placed.map(item => [item.square, item.piece]))

    const grid: string[] = []
    for (let row = 0; row < rows.value; row++) {
      const cells: string[] = []
      for (let col = 0; col < cols.value; col++) {
        const piece = bySquare.get(squareAt.value(col, row))
        const letter = piece ? piece.role[0] : '.'
        cells.push(piece && piece.side === 'first' ? letter.toUpperCase() : letter)
      }
      // Rank label is the numeric tail of the square at this row's first file.
      const rank = squareAt.value(0, row).slice(1)
      grid.push(`${rank.padStart(2)} | ${cells.join(' ')}`)
    }
    const files = Array.from({ length: cols.value }, (_, col) => String.fromCharCode(97 + col)).join(' ')
    grid.push(`     ${files}`)

    const listFor = (side: Side): string => {
      const byRole = new Map<string, string[]>()
      for (const item of placed) {
        if (item.piece.side !== side) {
          continue
        }
        const squares = byRole.get(item.piece.role) ?? []
        squares.push(item.square)
        byRole.set(item.piece.role, squares)
      }
      const parts = [...byRole].map(([role, squares]) => `${PIECE_NAMES[v][side][role] ?? role} ${squares.join(' ')}`)
      return parts.length ? parts.join('，') : '(无)'
    }

    const firstLabel = v === 'xiangqi' ? '红方(先手)' : '白方(先手)'
    const secondLabel = '黑方(后手)'
    return [
      '棋盘（大写=先手方，小写=后手方，. =空格）：',
      ...grid,
      `${firstLabel}棋子：${listFor('first')}`,
      `${secondLabel}棋子：${listFor('second')}`,
    ].join('\n')
  }

  function selectableBy(square: string): boolean {
    return pieces.value[square]?.side === turn.value
  }

  /** Handles a click on a board square during play. */
  function onSquareClick(square: string) {
    if (!rules || phase.value !== 'playing' || thinking.value || isOpponentTurn()) {
      return
    }

    if (selected.value && targets.value.has(square)) {
      const move = rules.move({ from: selected.value, to: square })
      selected.value = ''
      targets.value = new Set()
      if (move) {
        recordMove(move)
        refresh()
        if (rules.isGameOver()) {
          phase.value = 'over'
        }
        else if (isOpponentTurn()) {
          void playOpponentMove()
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
    await loadRules()

    if (mode.value === 'vs-airi') {
      try {
        // Server-side native engine when reachable, built-in search otherwise.
        engine = await createGameEngine(variant.value)
        engineSource.value = engine.source
      }
      catch (error) {
        errorMessage.value = errorMessageFrom(error) ?? 'Failed to start the engine.'
        return
      }
    }

    phase.value = 'playing'
    if (isOpponentTurn()) {
      void playOpponentMove()
    }
  }

  /** Returns to the setup panel. */
  function restart() {
    engine?.dispose()
    engine = undefined
    engineSource.value = ''
    phase.value = 'setup'
    void loadRules()
  }

  /** Switches variant while still in setup, re-rendering the starting board. */
  function changeVariant(next: Variant) {
    if (phase.value !== 'setup') {
      return
    }
    variant.value = next
    void loadRules()
  }

  // Render the default board immediately.
  void loadRules()

  return {
    variant,
    mode,
    airiSide,
    playerLevel,
    phase,
    thinking,
    errorMessage,
    engineSource,
    cols,
    rows,
    squareAt,
    pieces,
    turn,
    inCheck,
    selected,
    targets,
    lastMove,
    plies,
    history,
    result,
    statusText,
    thinkingLabel,
    analyzeForCoach,
    describeBoard,
    onSquareClick,
    startGame,
    restart,
    changeVariant,
  }
}

export type UseChessGame = ReturnType<typeof useChessGame>
