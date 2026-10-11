import 'dotenv/config'

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { temporaryFile } from 'tempy'

import type { BookMetadata } from './types'
import { assert, getEnv, readJsonFile } from './utils'

const execFileAsync = promisify(execFile)

// Builds an EPUB from `book.md` (or `book.<lang>.md` with `BOOK_LANGUAGE`)
// using Pandoc, so run `export-book-markdown.ts` first.
async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const lang = getEnv('BOOK_LANGUAGE')
  const suffix = lang ? `.${lang}` : ''
  const outDir = path.join('out', asin)

  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  assert(metadata.meta, 'invalid book metadata: missing meta')

  const markdown = await fs.readFile(
    path.join(outDir, `book${suffix}.md`),
    'utf8'
  )

  // Drop the title and hand-written table of contents at the top of the
  // markdown export; Pandoc generates both for the EPUB.
  const bodyParts = markdown.split(/^---$/m).slice(2)
  assert(bodyParts.length, `unexpected format in book${suffix}.md`)
  const body = bodyParts.join('---')

  const bodyPath = temporaryFile({ extension: 'md' })
  await fs.writeFile(bodyPath, body)

  const epubPath = path.join(outDir, `book${suffix}.epub`)
  const title = metadata.meta.title.replace(/\s*\([^)]*edition\)\s*$/i, '')

  await execFileAsync(getEnv('PANDOC_PATH') || 'pandoc', [
    bodyPath,
    '--from',
    'markdown',
    '--output',
    epubPath,
    '--metadata',
    `title=${title}`,
    '--metadata',
    `author=${metadata.meta.authorList.join(', ')}`,
    '--metadata',
    `lang=${lang || metadata.meta.language || 'en'}`,
    '--split-level=2',
    '--toc-depth=2'
  ])

  await fs.rm(bodyPath, { force: true })
  console.log(`Generated ${epubPath}`)
}

await main()
