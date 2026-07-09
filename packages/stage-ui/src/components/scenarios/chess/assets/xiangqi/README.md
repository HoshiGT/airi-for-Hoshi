# Xiangqi board + piece skin

## Board

`xiangqi-board.svg` (432×480) is the full board drawing: wood background,
outer border, the 9×10 line grid (verticals broken at the river), palace
diagonals, cannon/pawn point markers, and 楚河/漢界 river text (added by us;
the source had a blank river). `Board.vue` stretches it over the container
(`background-size: 100% 100%`); grid lines sit at cell centres (24 + 48k), so
per-cell pieces land on the intersections.

## Pieces

`xiangqi-pieces-sprite.svg` is the live skin: a 336×96 vector sprite of
7 columns × 2 rows of 48px cells, rendered by `Board.vue` the same way as the
chess sprite (one div per piece, `background-size: 700% 200%` +
`background-position`).

- **Column order:** K A B N R C P (`k a b n r c p` role letters).
- **Rows:** red (`first`, 先手) on top, black (`second`, 后手) below.
- **Cell anatomy:** an r=22 disc centred in the 48px cell (solid red/black fill,
  glyph carved in white), so the disc carries ~2px of margin on every side.

Provenance: both files were extracted from a user-supplied animated xiangqi
SVG (`ejceesanimate*.svg`): pieces from tiles `tile2`–`tile15`, the board from
its background/grid paths and marker tiles; the animation scaffolding and the
piece `<use>` setup were dropped.

To swap the skin, replace the sprite file keeping the same grid, column order,
and per-cell margin.
