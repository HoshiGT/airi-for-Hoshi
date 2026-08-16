import type { RehypeShikiOptions } from '@shikijs/rehype'
import type { BundledLanguage } from 'shiki'
import type { Processor } from 'unified'

import rehypeShiki from '@shikijs/rehype'
import rehypeKatex from 'rehype-katex'
import RehypeStringify from 'rehype-stringify'
import remarkMath from 'remark-math'
import RemarkParse from 'remark-parse'
import RemarkRehype from 'remark-rehype'

import { defaultPerfTracer } from '@proj-airi/stage-shared'
import { unified } from 'unified'

// Define a specific, compatible type for our processor to ensure type safety.
type MarkdownProcessor = Processor<any, any, any, any, string>

const processorCache = new Map<string, Promise<MarkdownProcessor>>()
const langRegex = /```(.{2,})\s/g

function extractLangs(markdown: string): BundledLanguage[] {
  const matches = markdown.matchAll(langRegex)
  const langs = new Set<BundledLanguage>()
  langs.add('python')
  for (const match of matches) {
    if (match[1])
      langs.add(match[1] as BundledLanguage)
  }
  return [...langs]
}

function measuredKatex(options?: Parameters<typeof rehypeKatex>[0]) {
  const transform = rehypeKatex(options)
  return (tree: any, file: any) => {
    const start = performance.now()
    const length = typeof file?.value === 'string' ? file.value.length : undefined
    try {
      return transform(tree, file)
    }
    finally {
      defaultPerfTracer.emit({
        tracerId: 'markdown',
        name: 'process.katex',
        ts: start,
        duration: performance.now() - start,
        meta: { length },
      })
    }
  }
}

async function createProcessor(langs: BundledLanguage[]): Promise<MarkdownProcessor> {
  const options: RehypeShikiOptions = {
    themes: {
      light: 'github-light',
      dark: 'github-dark',
    },
    langs,
    defaultLanguage: langs[0] || 'python',
  }

  return unified()
    .use(RemarkParse)
    .use(remarkMath)
    .use(RemarkRehype)
    .use(measuredKatex, { output: 'mathml' })
    .use(rehypeShiki, options)
    .use(RehypeStringify)
}

function getProcessor(langs: BundledLanguage[]): Promise<MarkdownProcessor> {
  // The cache key should be consistent, so we sort the languages.
  const cacheKey = [...langs].sort().join(',')

  if (!processorCache.has(cacheKey)) {
    const processorPromise = createProcessor(langs)
    processorCache.set(cacheKey, processorPromise)
  }

  return processorCache.get(cacheKey)!
}

// Shared across all MarkdownRenderer instances — unified processors are
// stateless after configuration so a single instance is safe to reuse.
const sharedFallbackProcessor = unified()
  .use(RemarkParse)
  .use(remarkMath)
  .use(RemarkRehype)
  .use(measuredKatex, { output: 'mathml' })
  .use(RehypeStringify)

/**
 * How many rendered messages to keep. Chat history re-mounts every message when
 * the user switches conversations, and shiki highlighting dominates that cost,
 * so the cache only needs to span a few conversations' worth of bubbles.
 */
const RENDERED_CACHE_LIMIT = 400

/**
 * Rendered HTML keyed by source markdown.
 *
 * Insertion-ordered so the oldest entry can be evicted once the cap is hit
 * (a plain LRU would need a touch-on-read reinsert; switching back and forth
 * between two conversations stays inside the cap either way).
 *
 * Keyed by the markdown text alone, which is safe because the pipeline is
 * deterministic and carries no per-message state — the same input always
 * produces the same HTML. Streaming messages grow by a token per update and so
 * miss constantly; that is fine, they are rendered once each anyway, and the
 * final full text lands in the cache for later re-mounts.
 */
const renderedCache = new Map<string, string>()

function readCache(markdown: string): string | undefined {
  return renderedCache.get(markdown)
}

function writeCache(markdown: string, html: string): string {
  if (renderedCache.size >= RENDERED_CACHE_LIMIT) {
    const oldestKey = renderedCache.keys().next().value
    if (oldestKey !== undefined)
      renderedCache.delete(oldestKey)
  }
  renderedCache.set(markdown, html)
  return html
}

export function useMarkdown() {
  return {
    process: async (markdown: string): Promise<string> => {
      const hasCodeFence = /`{3,}/.test(markdown)
      const meta = { length: markdown.length, hasCodeFence }

      // Re-mounting history (switching conversations, reopening the chat window)
      // asks for the exact same markdown again; skip the whole pipeline for it.
      const cached = readCache(markdown)
      if (cached !== undefined)
        return cached

      return defaultPerfTracer.withMeasure('markdown', 'process', async () => {
        try {
          // A quick check for code fences. If none, use the fast fallback.
          if (!hasCodeFence) {
            return defaultPerfTracer.withMeasure('markdown', 'process.pipeline.basic', () => {
              return writeCache(markdown, sharedFallbackProcessor.processSync(markdown).toString())
            }, meta)
          }

          const langs = extractLangs(markdown)

          // Always ensure 'python' is loaded as it's our default.
          const langSet = new Set(langs)
          langSet.add('python')
          const languagesToLoad = Array.from(langSet)

          const processor = await getProcessor(languagesToLoad)
          const result = await defaultPerfTracer.withMeasure('markdown', 'process.pipeline.rich', () => processor.process(markdown), meta)
          // Only the highlighted output is worth caching; the fallback below is
          // a degraded render that a later attempt may be able to improve on.
          return writeCache(markdown, result.toString())
        }
        catch (error) {
          console.warn(
            'Failed to process markdown with syntax highlighting, falling back to basic processing:',
            error,
          )
          // Fallback to basic processor without highlighting
          return defaultPerfTracer.withMeasure('markdown', 'process.pipeline.fallback', () => {
            return sharedFallbackProcessor.processSync(markdown).toString()
          }, { ...meta, fallback: true })
        }
      }, meta)
    },

    // Synchronous version for backward compatibility
    processSync: (markdown: string): string => {
      const start = performance.now()
      const output = sharedFallbackProcessor
        .processSync(markdown)
        .toString()

      defaultPerfTracer.emit({
        tracerId: 'markdown',
        name: 'process.pipeline.sync',
        ts: start,
        duration: performance.now() - start,
        meta: { length: markdown.length },
      })

      return output
    },
  }
}
