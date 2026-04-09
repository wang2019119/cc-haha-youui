/**
 * 消息格式化工具
 */

/** Split text into chunks that fit within a character limit, respecting paragraph/sentence boundaries. */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n\n', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit)
    if (splitAt <= 0) splitAt = limit

    // Include the delimiter for paragraph/sentence breaks
    if (remaining[splitAt] === '\n' || remaining[splitAt] === '.') splitAt += 1

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

/** Format tool use info for display in IM. */
export function formatToolUse(toolName: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const summary = formatToolSummary(toolName, inp)
  if (summary) return `🔧 ${toolName}  ${summary}`
  const preview = truncateInput(input, 200)
  return `🔧 ${toolName}\n${preview}`
}

/** Generate a concise human-readable summary for common tools. */
function formatToolSummary(tool: string, inp: Record<string, unknown>): string | null {
  switch (tool) {
    case 'Bash': {
      const desc = inp.description as string | undefined
      const cmd = inp.command as string | undefined
      if (desc) return desc
      if (cmd) return truncate(cmd, 120)
      return null
    }
    case 'Read': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Edit': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Write': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Grep': {
      const pat = inp.pattern as string | undefined
      const p = inp.path as string | undefined
      if (pat) return `"${truncate(pat, 60)}"` + (p ? ` in ${shortPath(p)}` : '')
      return null
    }
    case 'Glob': {
      const pat = inp.pattern as string | undefined
      return pat ? `"${pat}"` : null
    }
    case 'Skill': {
      const skill = inp.skill as string | undefined
      return skill || null
    }
    case 'Agent': {
      const desc = inp.description as string | undefined
      return desc || null
    }
    case 'WebFetch': {
      const url = inp.url as string | undefined
      return url ? truncate(url, 120) : null
    }
    case 'WebSearch': {
      const q = inp.query as string | undefined
      return q ? `"${truncate(q, 80)}"` : null
    }
    default:
      return null
  }
}

function shortPath(fp: string): string {
  const parts = fp.split('/')
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : fp
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Format a permission request for display in IM. */
export function formatPermissionRequest(toolName: string, input: unknown, requestId: string): string {
  const preview = truncateInput(input, 300)
  return `🔐 需要权限确认 [${requestId}]\n工具: ${toolName}\n${preview}`
}

/** Truncate tool input to a preview string. */
export function truncateInput(input: unknown, maxLen: number): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  } catch {
    return '(unserializable)'
  }
}

/** Escape special characters for Telegram MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}
