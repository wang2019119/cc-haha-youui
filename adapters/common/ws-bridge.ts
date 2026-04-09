/**
 * WebSocket Bridge
 *
 * 封装与 Claude Code Desktop 服务端 /ws/:sessionId 的通信。
 * 管理 chatId → sessionId 映射，自动重连，心跳。
 */

import WebSocket from 'ws'

/** Server → Client message (mirrors src/server/ws/events.ts ServerMessage) */
export type ServerMessage = {
  type: string
  [key: string]: any
}

/** Callback for server messages */
export type MessageHandler = (msg: ServerMessage) => void

type Session = {
  sessionId: string
  ws: WebSocket
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

const HEARTBEAT_INTERVAL_MS = 30_000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 10

export class WsBridge {
  private sessions = new Map<string, Session>()
  /** Single handler per chatId — separate from sessions so reconnect doesn't duplicate */
  private handlers = new Map<string, MessageHandler>()
  private serverUrl: string
  private platform: string
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  constructor(serverUrl: string, platform: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '')
    this.platform = platform
    this.startHeartbeat()
  }

  /** Connect to a session with a known sessionId. Returns false if already connected. */
  connectSession(chatId: string, sessionId: string): boolean {
    const existing = this.sessions.get(chatId)
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      return false
    }
    this.connect(chatId, sessionId)
    return true
  }

  /** Send a user message to the session bound to chatId. */
  sendUserMessage(chatId: string, content: string): boolean {
    return this.send(chatId, { type: 'user_message', content })
  }

  /** Respond to a permission request. */
  sendPermissionResponse(chatId: string, requestId: string, allowed: boolean): boolean {
    return this.send(chatId, { type: 'permission_response', requestId, allowed })
  }

  /** Stop the current generation. */
  sendStopGeneration(chatId: string): boolean {
    return this.send(chatId, { type: 'stop_generation' })
  }

  /** Register (or replace) the handler for server messages on a specific chatId. */
  onServerMessage(chatId: string, handler: MessageHandler): void {
    this.handlers.set(chatId, handler)
  }

  /** Reset session for a chatId (e.g. /new command). */
  resetSession(chatId: string): void {
    const session = this.sessions.get(chatId)
    if (session) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
      session.ws.close(1000, 'session reset')
      this.sessions.delete(chatId)
    }
    this.handlers.delete(chatId)
  }

  /** Has a session (connected or handler registered) for chatId. */
  hasSession(chatId: string): boolean {
    return this.sessions.has(chatId) || this.handlers.has(chatId)
  }

  /** Destroy all sessions. */
  destroy(): void {
    this.destroyed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const [, session] of this.sessions) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
      session.ws.close(1000, 'bridge destroyed')
    }
    this.sessions.clear()
    this.handlers.clear()
  }

  // ------- internal -------

  private connect(chatId: string, sessionId: string): void {
    const url = `${this.serverUrl}/ws/${sessionId}`
    const ws = new WebSocket(url)

    // Cancel any pending reconnect timer for this chatId
    const prev = this.sessions.get(chatId)
    if (prev) {
      if (prev.reconnectTimer) clearTimeout(prev.reconnectTimer)
      prev.ws.removeAllListeners()
    }

    const session: Session = {
      sessionId,
      ws,
      reconnectAttempts: prev?.reconnectAttempts ?? 0,
      reconnectTimer: null,
    }
    this.sessions.set(chatId, session)

    ws.on('open', () => {
      console.log(`[WsBridge] Connected: ${sessionId}`)
      session.reconnectAttempts = 0
    })

    ws.on('message', (raw) => {
      try {
        const msg: ServerMessage = JSON.parse(raw.toString())
        if (msg.type === 'pong') return
        const handler = this.handlers.get(chatId)
        if (handler) handler(msg)
      } catch (err) {
        console.error('[WsBridge] Parse error:', err)
      }
    })

    ws.on('close', (code, reason) => {
      console.log(`[WsBridge] Disconnected: ${sessionId} (${code}: ${reason})`)
      if (code === 1000) return
      this.scheduleReconnect(chatId, sessionId)
    })

    ws.on('error', (err) => {
      console.error(`[WsBridge] Error on ${sessionId}:`, err.message)
    })
  }

  /** Wait until the WebSocket for chatId is open. Resolves false on timeout or error. */
  waitForOpen(chatId: string, timeoutMs = 10_000): Promise<boolean> {
    const session = this.sessions.get(chatId)
    if (!session) return Promise.resolve(false)
    if (session.ws.readyState === WebSocket.OPEN) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      const onOpen = () => { cleanup(); resolve(true) }
      const onError = () => { cleanup(); resolve(false) }
      const onClose = () => { cleanup(); resolve(false) }
      const cleanup = () => {
        clearTimeout(timer)
        session.ws.removeListener('open', onOpen)
        session.ws.removeListener('error', onError)
        session.ws.removeListener('close', onClose)
      }
      session.ws.once('open', onOpen)
      session.ws.once('error', onError)
      session.ws.once('close', onClose)
    })
  }

  private send(chatId: string, message: Record<string, unknown>): boolean {
    const session = this.sessions.get(chatId)
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[WsBridge] Cannot send to ${chatId}: session not ready`)
      return false
    }
    session.ws.send(JSON.stringify(message))
    return true
  }

  private scheduleReconnect(chatId: string, sessionId: string): void {
    if (this.destroyed) return
    const session = this.sessions.get(chatId)
    if (!session) return
    if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[WsBridge] Max reconnect attempts reached for ${sessionId}, giving up`)
      this.sessions.delete(chatId)
      this.handlers.delete(chatId)
      return
    }

    session.reconnectAttempts++
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, session.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    )
    console.log(`[WsBridge] Reconnecting ${sessionId} in ${delay}ms (attempt ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
    session.reconnectTimer = setTimeout(() => {
      if (this.destroyed) return
      if (this.sessions.get(chatId)?.sessionId === sessionId) {
        this.connect(chatId, sessionId)
      }
    }, delay)
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [, session] of this.sessions) {
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({ type: 'ping' }))
        }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }
}
