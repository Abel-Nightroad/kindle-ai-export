import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Make sure Claude Code signs in with your subscription rather than an API key
// that may be set in `.env`.
// eslint-disable-next-line no-process-env
const { ANTHROPIC_API_KEY: _apiKey, ...claudeEnv } = process.env

export class UsageLimitError extends Error {}

/**
 * Runs a single prompt through the Claude Code CLI (`claude -p`), so it uses
 * your Claude subscription instead of API credits.
 */
export async function runClaudeCode({
  prompt,
  model,
  systemPrompt,
  tools = []
}: {
  prompt: string
  model: string
  systemPrompt: string
  tools?: string[]
}): Promise<string> {
  const { stdout } = await execFileAsync(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      model,
      '--tools',
      tools.join(','),
      ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
      '--system-prompt',
      systemPrompt,
      // Skip user plugins, hooks and MCP servers; they aren't needed here.
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--output-format',
      'json'
    ],
    { env: claudeEnv, maxBuffer: 16 * 1024 * 1024 }
  ).catch((err: any) => {
    // `claude -p` exits non-zero on errors but still prints its JSON result.
    if (err.stdout) return { stdout: err.stdout as string }
    throw err
  })

  const res = JSON.parse(stdout) as { is_error?: boolean; result?: string }
  if (res.is_error) {
    const message = res.result ?? 'unknown Claude Code error'
    if (/limit/i.test(message)) throw new UsageLimitError(message)
    throw new Error(message)
  }

  const text = res.result ?? ''
  if (/^(I (can't|cannot|can not|won't|am unable)|En voi)/i.test(text)) {
    throw new Error(`Model declined: ${text.slice(0, 200)}`)
  }

  return text
}
