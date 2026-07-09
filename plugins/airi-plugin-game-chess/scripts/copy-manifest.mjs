// Copies the extension manifest into `dist` so the built directory is a
// self-contained, deployable extension:
//
//   dist/
//     extension.airi.json   (entrypoint "./index.mjs", UI at "ui/index.html")
//     index.mjs             (Node entrypoint, built by tsdown)
//     ui/                   (iframe board UI + engines, built by vite)
//
// Deploy by copying `dist/` into `<userData>/extensions/v1/<name>/`.

import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
await mkdir(resolve(root, 'dist'), { recursive: true })
await copyFile(resolve(root, 'extension.airi.json'), resolve(root, 'dist', 'extension.airi.json'))

console.info('[airi-plugin-game-chess] copied extension.airi.json into dist')
