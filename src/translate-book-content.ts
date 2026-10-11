import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import pMap from 'p-map'

import type { BookMetadata, ContentChunk } from './types'
import { runClaudeCode, UsageLimitError } from './claude-code'
import { assert, getEnv, readJsonFile, tryReadJsonFile } from './utils'

// Translates `content.json` into another language via the Claude Code CLI, so
// it uses your Claude subscription instead of API credits. The result is
// written to `content.<lang>.json`; export it with `BOOK_LANGUAGE=<lang>`.
const languageCode = getEnv('BOOK_LANGUAGE') || 'fi'
const languageName = getEnv('BOOK_LANGUAGE_NAME') || 'Finnish'
const model = getEnv('CLAUDE_TRANSLATE_MODEL') || 'claude-haiku-5-5'
const concurrency = Number(getEnv('CLAUDE_OCR_CONCURRENCY') || 4)

const systemPrompt = `You translate passages from a novel the user owns into ${languageName}, for their personal reading.

Output only the ${languageName} translation, with nothing before or after it. Keep one paragraph per line, matching the paragraphs of the original. Keep names of people and places unchanged. Translate naturally and faithfully, preserving dialogue and tone. Do not use markdown.`

// Matches the end of a sentence, including closing quotes or brackets.
const sentenceEndRegex = /[!.?…]["')»«’”]*/g

/**
 * Page screenshots often end mid-sentence. Move each trailing partial sentence
 * onto the start of the next chunk, so no sentence is translated in two halves.
 */
function rebalanceSentences(chunks: ContentChunk[]): ContentChunk[] {
  const result = chunks.map((chunk) => ({ ...chunk }))

  for (let i = 0; i < result.length - 1; i++) {
    const chunk = result[i]!
    const text = chunk.text.trimEnd()

    let lastEnd = -1
    for (const match of text.matchAll(sentenceEndRegex)) {
      lastEnd = match.index + match[0].length
    }

    // Already ends on a sentence boundary, or is one long fragment.
    if (lastEnd === -1 || lastEnd === text.length) continue

    const tail = text.slice(lastEnd).trim()
    chunk.text = text.slice(0, lastEnd)
    result[i + 1]!.text = `${tail} ${result[i + 1]!.text}`
  }

  return result
}

async function translateTocLabels(labels: string[]) {
  const text = await runClaudeCode({
    prompt: `Translate each of these chapter titles into ${languageName}. Reply with only a JSON array of strings, in the same order:\n\n${JSON.stringify(labels)}`,
    model,
    systemPrompt: `You translate book chapter titles into ${languageName}. Reply with only valid JSON.`
  })

  const translated = JSON.parse(
    text.replaceAll(/^```(?:json)?\s*|\s*```$/g, '')
  ) as string[]
  assert(
    Array.isArray(translated) && translated.length === labels.length,
    'chapter title translation returned the wrong number of titles'
  )

  return Object.fromEntries(labels.map((label, i) => [label, translated[i]!]))
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const translatedPath = path.join(outDir, `content.${languageCode}.json`)
  const tocLabelsPath = path.join(outDir, `toc.${languageCode}.json`)

  const content = await readJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(content.length, 'no book content found; run the transcribe step first')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  try {
    if (!(await tryReadJsonFile(tocLabelsPath))) {
      const labels = [...new Set(metadata.toc.map((tocItem) => tocItem.label))]
      console.log(`Translating ${labels.length} chapter titles...`)
      const tocLabels = await translateTocLabels(labels)
      await fs.writeFile(tocLabelsPath, JSON.stringify(tocLabels, null, 2))
    }
  } catch (err: any) {
    if (err instanceof UsageLimitError) {
      console.error(`Usage limit reached: ${err.message}`)
      return
    }
    // Not fatal: the exports fall back to the original chapter titles.
    console.warn('Could not translate chapter titles:', err.message)
  }

  const chunks = rebalanceSentences(content)

  // Resume from a previous run: keep chunks that were already translated.
  const done = new Map<number, ContentChunk>()
  for (const chunk of (await tryReadJsonFile<ContentChunk[]>(translatedPath)) ??
    []) {
    done.set(chunk.index, chunk)
  }

  const todo = chunks.filter((chunk) => !done.has(chunk.index))
  console.log(
    `Translating ${todo.length} of ${chunks.length} chunks into ${languageName} with ${model} (${done.size} already done)`
  )

  async function saveTranslation() {
    const translated = [...done.values()].toSorted((a, b) => a.index - b.index)
    await fs.writeFile(translatedPath, JSON.stringify(translated, null, 2))
  }

  let usageLimitHit = false
  let failed = 0

  await pMap(
    todo,
    async (chunk) => {
      if (usageLimitHit) return

      try {
        // Nothing to translate, e.g. after moving its only sentence forward.
        const text = chunk.text.trim()
          ? (
              await runClaudeCode({
                prompt: chunk.text,
                model,
                systemPrompt
              })
            )
              .replaceAll(/^\s*/gm, '')
              .replaceAll(/\s*$/gm, '')
          : ''

        done.set(chunk.index, { ...chunk, text })
        await saveTranslation()
        console.log(
          `[${done.size}/${chunks.length}] page ${chunk.page} (chunk ${chunk.index})`
        )
      } catch (err: any) {
        if (err instanceof UsageLimitError) {
          usageLimitHit = true
          console.error(`\nUsage limit reached: ${err.message}`)
          return
        }

        ++failed
        console.error(`error translating chunk ${chunk.index}:`, err.message)
      }
    },
    { concurrency }
  )

  await saveTranslation()

  const remaining = chunks.length - done.size
  if (remaining) {
    console.log(
      `\n${remaining} chunks not translated yet${failed ? ` (${failed} failed)` : ''}. Run this script again to continue${usageLimitHit ? ' once your usage limit resets' : ''}.`
    )
  } else {
    console.log(
      `\nDone: all ${done.size} chunks translated to ${translatedPath}. Export with BOOK_LANGUAGE=${languageCode}.`
    )
  }
}

await main()
