import type { OneBot } from '@proj-airi/plugin-protocol/types'
import type { WebSocket } from 'ws'

import { useLogg } from '@guiiai/logg'
import { Client as AiriClient } from '@proj-airi/server-sdk'
import { WebSocketServer } from 'ws'

const log = useLogg('QQAdapter').useGlobalConfig()

export interface QQAdapterConfig {
  /** 反向 WS 监听端口，NapCat 连进来 */
  wsPort?: number
  /** NapCat access_token，没有留空 */
  napCatToken?: string
  /** bot 自身 QQ 号，用于群聊 @ 检测 */
  botUin?: number
  /**
   * 白名单：只作用于群聊——群消息只有名单内的发送者会被转发给 Airi；
   * 私聊不过滤（一律响应）。空数组表示群聊也不限制。
   */
  allowedUserIds?: number[]
  airiToken?: string
  airiUrl?: string
}

interface OneBotMessageEvent {
  post_type: 'message'
  message_type: 'private' | 'group'
  sub_type?: string
  message_id: number
  user_id: number
  group_id?: number
  self_id: number
  raw_message: string
  message: Array<{ type: string, data: Record<string, string> }>
  sender: {
    user_id: number
    nickname: string
    card?: string
  }
}

interface OneBotEvent {
  post_type?: string
  status?: string
  echo?: string
  [key: string]: unknown
}

export class QQAdapter {
  private airiClient: AiriClient
  private wss: WebSocketServer | null = null
  /** 当前 NapCat 连接（反向 WS 模式下 NapCat 是客户端） */
  private napCatConn: WebSocket | null = null
  private echoCounter = 0
  /** 进行中的 WS 重启；并发触发时后到者等待同一次重启完成，不叠加执行 */
  private restartTask: Promise<void> | null = null
  private readonly config: Required<QQAdapterConfig>

  constructor(config: QQAdapterConfig) {
    this.config = {
      wsPort: config.wsPort || 14514,
      napCatToken: config.napCatToken || '',
      botUin: config.botUin || 0,
      allowedUserIds: config.allowedUserIds || [],
      airiToken: config.airiToken || '',
      airiUrl: config.airiUrl || 'ws://localhost:6121/ws',
    }

    this.airiClient = new AiriClient({
      name: 'proj-airi:qq-bot',
      possibleEvents: [
        'input:text',
        'output:gen-ai:chat:message',
        'output:gen-ai:chat:complete',
      ],
      token: this.config.airiToken || undefined,
      url: this.config.airiUrl,
    })

    this.setupAiriHandlers()
  }

  private setupAiriHandlers(): void {
    // 设置页（模块→QQ）的「重启 WS 服务器」按钮：UI 发 `ui:configure`，
    // server-runtime 按本进程 announce 的模块名（proj-airi:qq-bot）路由成
    // `module:configure` 直发过来。config 用 command 字段区分一次性指令
    // 与真正的配置推送（目前只有 restart-ws-server 一个指令）。
    this.airiClient.onEvent('module:configure', async (event) => {
      const config = (event.data as { config?: Record<string, unknown> }).config
      if (config?.command === 'restart-ws-server') {
        log.log('Restart WS server command received from stage settings')
        await this.restartWsServer()
      }
    })

    this.airiClient.onEvent('output:gen-ai:chat:message', async (event) => {
      try {
        const message = (event.data as { message?: { content?: string } }).message
        if (!message?.content)
          return

        const genAiOutput = (event.data as Record<string, unknown>)['gen-ai:chat'] as {
          input?: { data?: { onebot?: OneBot } }
        } | undefined
        const onebotCtx = genAiOutput?.input?.data?.onebot
        if (!onebotCtx)
          return

        this.sendToQQ(onebotCtx, message.content)
      }
      catch (error) {
        log.withError(error as Error).error('Failed to send response to QQ')
      }
    })
  }

  private sendToQQ(ctx: OneBot, text: string): void {
    // 编排层按块过滤空白（整块全空白才丢），模型首块形如 "\n\n你好" 时
    // 开头换行会原样留在 content 里；UI 的 markdown 渲染会吞掉它，
    // 但 QQ 是纯文本会显示成开头空行，这里整体 trim 掉。
    const trimmed = text.trim()
    if (!trimmed)
      return

    for (const chunk of splitMessage(trimmed)) {
      if (ctx.groupId) {
        this.callApi('send_group_msg', { group_id: ctx.groupId, message: chunk })
      }
      else {
        this.callApi('send_private_msg', { user_id: ctx.userId, message: chunk })
      }
    }
  }

  /** 通过反向 WS 连接调用 NapCat API */
  private callApi(action: string, params: Record<string, unknown>): void {
    if (!this.napCatConn) {
      log.warn('No NapCat connection, dropping API call')
      return
    }
    this.napCatConn.send(JSON.stringify({
      action,
      params,
      echo: String(++this.echoCounter),
    }))
  }

  /**
   * 重启反向 WS 服务器（关掉旧 server + 踢掉 NapCat 连接后重新 listen）。
   * NapCat 侧配置了反向 WS 自动重连，会在几秒内连回来。
   */
  async restartWsServer(): Promise<void> {
    if (this.restartTask)
      return this.restartTask

    this.restartTask = (async () => {
      log.log('Restarting reverse WS server...')
      await this.stopWsServer()
      this.startWsServer()
    })().finally(() => {
      this.restartTask = null
    })
    return this.restartTask
  }

  private async stopWsServer(): Promise<void> {
    const wss = this.wss
    this.wss = null
    this.napCatConn = null
    if (!wss)
      return

    // terminate 而不是优雅 close：重启就是给「连接看着在、实际卡死」的场景
    // 兜底用的，优雅关闭握手在那种状态下可能永远收不到回应。
    for (const client of wss.clients)
      client.terminate()

    // close 回调返回后端口才真正释放，之后重新 listen 才不会 EADDRINUSE
    await new Promise<void>(resolve => wss.close(() => resolve()))
    log.log('Reverse WS server stopped')
  }

  private startWsServer(): void {
    this.wss = new WebSocketServer({ port: this.config.wsPort })

    this.wss.on('listening', () => {
      log.withFields({ port: this.config.wsPort }).log('Reverse WS server listening, waiting for NapCat...')
    })

    // 不挂 error 监听的话，listen 失败（如端口被占）会以 uncaught exception
    // 直接带崩整个进程；重启场景里旧端口未释放时尤其容易踩到。
    this.wss.on('error', (err) => {
      log.withError(err).error('Reverse WS server error')
    })

    this.wss.on('connection', (ws, req) => {
      // 验证 access_token（如果配置了的话）
      if (this.config.napCatToken) {
        const url = new URL(req.url || '/', 'http://localhost')
        const token = url.searchParams.get('access_token')
          || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        if (token !== this.config.napCatToken) {
          log.warn('NapCat connected with wrong token, closing')
          ws.close(1008, 'Unauthorized')
          return
        }
      }

      log.log('NapCat connected')
      this.napCatConn = ws

      ws.on('message', (raw) => {
        try {
          const event = JSON.parse(raw.toString()) as OneBotEvent
          // API 响应帧（有 echo 字段），跳过
          if (event.echo !== undefined)
            return
          if (event.post_type === 'message')
            void this.handleMessage(event as unknown as OneBotMessageEvent)
        }
        catch {
          // ignore malformed frames
        }
      })

      ws.on('close', () => {
        log.warn('NapCat disconnected')
        if (this.napCatConn === ws)
          this.napCatConn = null
      })

      ws.on('error', (err) => {
        log.withError(err).error('NapCat WS error')
      })
    })
  }

  private async handleMessage(event: OneBotMessageEvent): Promise<void> {
    const isGroup = event.message_type === 'group'

    // 白名单只作用于群聊；私聊一律响应（2026-07-06 起：私聊过滤疑似误杀，
    // 先放开排查，群聊仍按发送者过滤）。Number() 兜住 user_id 以字符串形式
    // 到达的情况，避免和 number 数组比较永远不中。
    if (isGroup && this.config.allowedUserIds.length && !this.config.allowedUserIds.includes(Number(event.user_id))) {
      log.withFields({ user: event.user_id }).debug('Ignoring group message from non-whitelisted user')
      return
    }

    if (isGroup) {
      // 只响应 @bot 自身，忽略 @全体成员（qq: 'all'）和其他 @
      const mentionedBot = event.message.some(
        seg => seg.type === 'at' && seg.data.qq === String(this.config.botUin),
      )
      if (!mentionedBot)
        return
    }

    const text = extractText(event.message)
    if (!text.trim())
      return

    const senderName = event.sender.card || event.sender.nickname
    const onebotCtx: OneBot = {
      userId: event.user_id,
      groupId: event.group_id,
      messageId: event.message_id,
      selfId: event.self_id,
      sender: {
        userId: event.sender.user_id,
        nickname: senderName,
      },
    }

    const sessionId = isGroup
      ? `qq-group-${event.group_id}`
      : `qq-private-${event.user_id}`

    log.withFields({ sessionId, user: event.user_id }).log('Forwarding message to Airi')

    // NOTICE:
    // 不再随消息附带 AppendSelf contextUpdate。这些注记永不过期、逐条累积
    // （还按 qq-bot 实例 id 分组），几轮之后模型的输入尾部就挂着一串重复的
    // "The input is a private message from ..."，小模型会把它当成"系统日志"
    // 并开始对着日志自言自语（2026-07-06 实测复现）。发送者身份靠
    // messagePrefix 已经足够；回复路由只读 input.data.onebot，不依赖注记。
    // 若群聊场景需要群号上下文，届时应改为每会话只注记一次而不是每条消息。
    this.airiClient.send({
      type: 'input:text',
      data: {
        text,
        textRaw: event.raw_message,
        overrides: {
          messagePrefix: `(From QQ user ${senderName}): `,
          sessionId,
        },
        onebot: onebotCtx,
      },
    })
  }

  async start(): Promise<void> {
    log.log('Starting QQ adapter...')
    this.startWsServer()
    log.log('QQ adapter started')
  }

  async stop(): Promise<void> {
    log.log('Stopping QQ adapter...')
    await this.stopWsServer()
    this.airiClient.close()
  }
}

function extractText(segments: Array<{ type: string, data: Record<string, string> }>): string {
  return segments
    .filter(seg => seg.type === 'text')
    .map(seg => seg.data.text || '')
    .join('')
    .trim()
}

function splitMessage(text: string, maxLen = 2000): string[] {
  if (text.length <= maxLen)
    return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    const cut = remaining.lastIndexOf('\n', maxLen) > 0
      ? remaining.lastIndexOf('\n', maxLen)
      : remaining.lastIndexOf(' ', maxLen) > 0
        ? remaining.lastIndexOf(' ', maxLen)
        : maxLen
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).trim()
  }
  return chunks
}
