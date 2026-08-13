import { defaultPerfTracer } from '@proj-airi/stage-shared'
import { describe, expect, it, vi } from 'vitest'

import { useMarkdown } from './markdown'

describe('useMarkdown', () => {
  // ROOT CAUSE:
  //
  // The fallback processor was hoisted out of useMarkdown() into module scope and
  // renamed (`fallbackProcessor` → `sharedFallbackProcessor`), but `processSync`
  // kept referencing the old per-call binding, which no longer existed.
  //
  // const output = fallbackProcessor.processSync(markdown).toString()
  //
  // Every synchronous render therefore threw `ReferenceError: fallbackProcessor
  // is not defined`. That path is the last resort in markdown-renderer.vue — it
  // runs only when the async pipeline already failed — so the bug turned one
  // degraded render into a thrown error inside a catch block.
  //
  // Fixed by pointing processSync at the shared module-scope processor.
  it('renders markdown synchronously', () => {
    const { processSync } = useMarkdown()
    expect(processSync('# Hello')).toContain('<h1>Hello</h1>')
  })

  it('shares one processor across composable instances, so both render the same output', () => {
    // The hoist exists to stop every MarkdownRenderer from building its own
    // processor; assert the shared instance still works when reused.
    expect(useMarkdown().processSync('**bold**')).toBe(useMarkdown().processSync('**bold**'))
  })

  it('renders fence-free markdown through the async pipeline without loading shiki', async () => {
    const { process } = useMarkdown()
    await expect(process('plain *text*')).resolves.toContain('<em>text</em>')
  })

  it('serves repeated renders of the same markdown from cache', async () => {
    // Switching conversations re-mounts every bubble with identical content, and
    // the pipeline (remark → rehype → katex → shiki → stringify) is the bulk of
    // that cost. The tracer wraps every real render, so "no measurement" is the
    // observable proof that the second call never ran the pipeline.
    const { process } = useMarkdown()
    const source = `# cached heading ${Math.random()}\n\nwith a paragraph`

    const first = await process(source)

    const withMeasureSpy = vi.spyOn(defaultPerfTracer, 'withMeasure')
    const second = await process(source)

    expect(second).toBe(first)
    expect(withMeasureSpy).not.toHaveBeenCalled()
    withMeasureSpy.mockRestore()
  })
})
