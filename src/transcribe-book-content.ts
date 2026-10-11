import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import pMap from 'p-map'

import type { BookMetadata, ContentChunk, TocItem } from './types'
import { runClaudeCode, UsageLimitError } from './claude-code'
import { assert, getEnv, readJsonFile, tryReadJsonFile } from './utils'

// Transcription runs through the Claude Code CLI (`claude -p`), so it uses your
// Claude subscription instead of API credits. Haiku is accurate for clean page
// screenshots and uses the least of your subscription's usage limits.
const model = getEnv('CLAUDE_OCR_MODEL') || 'claude-haiku-5-5'
const concurrency = Number(getEnv('CLAUDE_OCR_CONCURRENCY') || 4)

const systemPrompt = `You transcribe pages from an ebook the user owns. Use the Read tool to open the image file you are given, then output the text from the image verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.`

function transcribeImage(imagePath: string): Promise<string> {
  return runClaudeCode({
    prompt: `Transcribe this page image: ${path.resolve(imagePath)}`,
    model,
    systemPrompt,
    tools: ['Read']
  })
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const contentPath = path.join(outDir, 'content.json')
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(metadata.pages?.length, 'no page screenshots found')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const pageToTocItemMap = metadata.toc.reduce(
    (acc, tocItem) => {
      if (tocItem.page !== undefined) {
        acc[tocItem.page] = tocItem
      }
      return acc
    },
    {} as Record<number, TocItem>
  )

  // Resume from a previous run: keep pages that were already transcribed.
  const done = new Map<number, ContentChunk>()
  for (const chunk of (await tryReadJsonFile<ContentChunk[]>(contentPath)) ??
    []) {
    done.set(chunk.index, chunk)
  }

  const todo = metadata.pages.filter((pageChunk) => !done.has(pageChunk.index))
  console.log(
    `Transcribing ${todo.length} of ${metadata.pages.length} pages with ${model} (${done.size} already done)`
  )

  async function saveContent() {
    const content = [...done.values()].toSorted((a, b) => a.index - b.index)
    await fs.writeFile(contentPath, JSON.stringify(content, null, 2))
  }

  let usageLimitHit = false
  let failed = 0

  await pMap(
    todo,
    async (pageChunk) => {
      if (usageLimitHit) return

      const { screenshot, index, page } = pageChunk
      const pageChunkIndex = metadata.pages.indexOf(pageChunk)

      try {
        const maxRetries = 3
        let text = ''

        for (let retries = 1; !text; ++retries) {
          const rawText = await transcribeImage(screenshot)
          text = rawText
            .replace(/^\s*\d+\s*$\n+/m, '')
            // .replaceAll(/\n+/g, '\n')
            .replaceAll(/^\s*/gm, '')
            .replaceAll(/\s*$/gm, '')

          if (!text && retries >= maxRetries) {
            throw new Error(`Empty transcription after ${retries} tries`)
          }
        }

        const prevPageChunk = metadata.pages[pageChunkIndex - 1]
        if (prevPageChunk && prevPageChunk.page !== page) {
          const tocItem = pageToTocItemMap[page]
          if (tocItem) {
            text = text.replace(
              // eslint-disable-next-line security/detect-non-literal-regexp
              new RegExp(`^${tocItem.label}\\s*`, 'i'),
              ''
            )
          }
        }

        done.set(index, { index, page, text, screenshot })
        await saveContent()
        console.log(
          `[${done.size}/${metadata.pages.length}] page ${page} (${screenshot})`
        )
      } catch (err: any) {
        if (err instanceof UsageLimitError) {
          usageLimitHit = true
          console.error(`\nUsage limit reached: ${err.message}`)
          return
        }

        ++failed
        console.error(
          `error processing image ${index} (${screenshot}):`,
          err.message
        )
      }
    },
    { concurrency }
  )

  await saveContent()

  const remaining = metadata.pages.length - done.size
  if (remaining) {
    console.log(
      `\n${remaining} pages not transcribed yet${failed ? ` (${failed} failed)` : ''}. Run this script again to continue${usageLimitHit ? ' once your usage limit resets' : ''}.`
    )
  } else {
    console.log(`\nDone: all ${done.size} pages transcribed to ${contentPath}`)
  }
}

await main()
