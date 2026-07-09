import type { PlacedPiece, Side } from './shared'

/**
 * Chinese xiangqi column notation (中式纵线记谱法): the traditional four-token
 * move names like 炮二平五 / 馬8进7 that Chinese players actually read, instead
 * of ffish's Western SAN (whose ranks are 1-based and clash with this
 * scenario's 0-based squares — a pawn landing on UI c4 would read "Pc5").
 *
 * Convention implemented (GB competition rules, common practice):
 * - Each side numbers the 9 files 1–9 from its OWN right: red 一..九 in Chinese
 *   numerals, black 1..9 in Arabic numerals.
 * - 进/退 is toward/away from the opponent; 平 is a same-rank move.
 * - Straight movers (车炮兵帅将) report the step count for 进/退 and the
 *   destination file for 平; diagonal movers (马相仕) always report the
 *   destination file, since they change file every move.
 * - Two identical pieces on one file are named 前/后 (front = nearer the
 *   opponent) instead of by file; three use 前/中/后. When two files BOTH carry
 *   doubled pawns, the file number replaces the piece name (前七进一) so the
 *   prefix stays unambiguous.
 */

/**
 * Display names per side. Red uses the simplified set, black the traditional
 * variants (車馬砲), matching common set printing — also reused by the coach's
 * board description in use-chess-game.ts.
 */
export const XIANGQI_PIECE_NAMES: Record<Side, Record<string, string>> = {
  first: { k: '帅', a: '仕', b: '相', n: '马', r: '车', c: '炮', p: '兵' },
  second: { k: '将', a: '士', b: '象', n: '馬', r: '車', c: '砲', p: '卒' },
}

const RED_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九']

/** Red writes numbers in Chinese numerals, black in Arabic — standard practice. */
function numeral(side: Side, value: number): string {
  return side === 'first' ? RED_NUMERALS[value - 1] : String(value)
}

/** File number as counted by the moving side: 1–9 from that side's own right. */
function fileNumber(side: Side, col: number): number {
  return side === 'first' ? 9 - col : col + 1
}

/**
 * Front-to-back label for tandem pieces on one file: 前/后 for a pair, 前/中/后
 * for three; four or more (pawns only) number the middle ones from the front.
 */
function tandemLabel(side: Side, index: number, count: number): string {
  if (index === 0) {
    return '前'
  }
  if (index === count - 1) {
    return '后'
  }
  return count === 3 ? '中' : numeral(side, index + 1)
}

/**
 * Names a xiangqi move in Chinese column notation. Squares are this scenario's
 * 0-based UI labels; `placed` is the position BEFORE the move (needed to know
 * the mover and its same-file twins).
 *
 * Before:
 * - from "h2" to "e2" (red cannon)
 *
 * After:
 * - "炮二平五"
 */
export function xiangqiMoveName(placed: PlacedPiece[], from: string, to: string): string {
  const mover = placed.find(item => item.square === from)
  // A legal move always has its mover; keep listing robust for callers anyway.
  if (!mover) {
    return `${from}${to}`
  }
  const { side, role } = mover.piece
  const fromCol = from.charCodeAt(0) - 97
  const fromRank = Number(from.slice(1))
  const toCol = to.charCodeAt(0) - 97
  const toRank = Number(to.slice(1))

  // Ranks grow away from red (rank 0 is red's back rank), so "toward the
  // opponent" is +rank for red and -rank for black.
  const advance = side === 'first' ? toRank - fromRank : fromRank - toRank
  const action = advance === 0 ? '平' : (advance > 0 ? '进' : '退')

  // Straight movers report how far they go; diagonal movers (马相仕) and any 平
  // report where they land.
  const target = action !== '平' && fromCol === toCol
    ? numeral(side, Math.abs(advance))
    : numeral(side, fileNumber(side, toCol))

  // 前/后 applies to 车马炮兵; 仕相 pairs on one file stay unambiguous through
  // 进/退 + destination file (one of the pair can only 进, the other only 退).
  const sameRole = placed.filter(item => item.piece.side === side && item.piece.role === role)
  const tandem = sameRole.filter(item => item.square.charCodeAt(0) - 97 === fromCol)
  if (tandem.length >= 2 && ['r', 'n', 'c', 'p'].includes(role)) {
    const frontFirst = [...tandem].sort((a, b) =>
      (Number(b.square.slice(1)) - Number(a.square.slice(1))) * (side === 'first' ? 1 : -1))
    const label = tandemLabel(side, frontFirst.findIndex(item => item.square === from), frontFirst.length)

    // Doubled pawns on more than one file: 前兵 alone would not say which file,
    // so the rules swap the piece name for the origin file number (前七进一).
    const doubledFiles = new Set(
      sameRole
        .map(item => item.square.charCodeAt(0) - 97)
        .filter((col, _, cols) => cols.filter(candidate => candidate === col).length >= 2),
    )
    if (role === 'p' && doubledFiles.size >= 2) {
      return `${label}${numeral(side, fileNumber(side, fromCol))}${action}${target}`
    }
    return `${label}${XIANGQI_PIECE_NAMES[side][role]}${action}${target}`
  }

  return `${XIANGQI_PIECE_NAMES[side][role]}${numeral(side, fileNumber(side, fromCol))}${action}${target}`
}
