import { defineExtension } from '@proj-airi/plugin-sdk'
import { createGamelet } from '@proj-airi/plugin-sdk-tamagotchi/kits/gamelet'
import { registerTools } from '@proj-airi/plugin-sdk-tamagotchi/kits/tool'
import { object, optional, picklist, safeParse } from 'valibot'

// Stable module id; the extension-ui widget is spawned against this id and the
// e2e scenarios reference it as `chess-like-main`.
const MODULE_ID = 'chess-like-main'

// Tool input: every field optional so Airi can open a default match by calling
// `play_chess` with no arguments. The board reads these via the gamelet payload.
const playChessInput = object({
  variant: optional(picklist(['chess', 'xiangqi'])),
  mode: optional(picklist(['vs-airi', 'two-player'])),
  airiSide: optional(picklist(['first', 'second'])),
  difficulty: optional(picklist(['easy', 'normal', 'hard'])),
})

/**
 * Chess & Xiangqi extension.
 *
 * Call stack:
 *
 * defineExtension.setup
 *   -> ctx.modules.register({ id: 'chess-like-main' })
 *   -> {@link createGamelet}            // mounts the iframe board UI
 *   -> {@link registerTools}            // exposes `play_chess` to Airi
 *        -> play_chess.execute
 *          -> board.open(settings)      // opens/focuses the board window
 *
 * The local WASM engines (Stockfish for chess, Fairy-Stockfish for xiangqi) run
 * inside the board iframe; Airi's per-move choice rides the host spark-notify
 * channel, so neither lives in this Node entrypoint.
 */
export default defineExtension({
  id: 'airi-plugin-game-chess',
  async setup(ctx) {
    const module = await ctx.modules.register({ id: MODULE_ID })

    const board = await createGamelet(module, {
      id: 'board',
      title: 'AIRI Chess',
      // Resolved against the deployed extension directory; the UI build emits
      // `ui/index.html` (see scripts/copy-manifest.mjs for the dist layout).
      indexPath: 'ui/index.html',
    })

    await registerTools(module, {
      prompt: {
        id: 'airi-plugin-game-chess.prompt',
        title: 'Chess & Xiangqi',
        content: [
          'Call `play_chess` to open the board and start a game of chess or Chinese chess (xiangqi).',
          'Omit arguments to play a default match (international chess, you as Black, normal difficulty).',
          'When it is your turn, you are offered the engine\'s top candidate moves with evaluations;',
          'pick the one that fits your mood and explain it briefly in character.',
        ].join(' '),
      },
      tools: [
        {
          id: 'play_chess',
          title: 'Play Chess',
          description: 'Open a chess or Chinese chess (xiangqi) board and start a match.',
          activation: {
            keywords: ['chess', 'xiangqi', 'board game', '象棋', '国际象棋', '下棋'],
          },
          inputSchema: playChessInput,
          async execute(input) {
            const parsed = safeParse(playChessInput, input)
            const settings = parsed.success ? parsed.output : {}

            // `autoStart` tells the board to begin immediately rather than wait
            // on the setup panel, since opening via the tool implies intent to play.
            await board.open({ ...settings, autoStart: true })

            const game = settings.variant === 'xiangqi' ? 'Chinese chess' : 'chess'
            return { ok: true, message: `Opened the ${game} board.` }
          },
        },
      ],
    })
  },
})
