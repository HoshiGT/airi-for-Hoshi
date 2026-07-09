import process, { env } from 'node:process'

import { Format, LogLevel, setGlobalFormat, setGlobalLogLevel, useLogg } from '@guiiai/logg'

import { QQAdapter } from './adapters/airi-adapter'

setGlobalFormat(Format.Pretty)
setGlobalLogLevel(LogLevel.Log)
const log = useLogg('Bot').useGlobalConfig()

async function main() {
  const adapter = new QQAdapter({
    wsPort: Number(env.WS_PORT || '14514'),
    napCatToken: env.NAPCAT_TOKEN || undefined,
    botUin: Number(env.QQ_BOT_UIN || '0'),
    // 逗号分隔的 QQ 白名单（只过滤群聊，私聊一律响应）；留空表示群聊也不限制。
    allowedUserIds: (env.QQ_ALLOWED_UIN || '')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0),
    airiToken: env.AIRI_TOKEN || undefined,
    airiUrl: env.AIRI_URL || 'ws://localhost:6121/ws',
  })

  await adapter.start()

  async function gracefulShutdown(signal: string) {
    log.log(`Received ${signal}, shutting down...`)
    await adapter.stop()
    process.exit(0)
  }

  process.on('SIGINT', async () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', async () => gracefulShutdown('SIGTERM'))
}

main().catch(err => log.withError(err).error('An error occurred'))
