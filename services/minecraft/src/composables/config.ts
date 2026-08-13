import type { BotOptions } from 'mineflayer'

import { env } from 'node:process'

import { z } from 'zod'

import { useLogger } from '../utils/logger'

const logger = useLogger()

const botAuthValues = ['mojang', 'microsoft', 'offline'] as const satisfies ReadonlyArray<NonNullable<BotOptions['auth']>>

function requiredString(envKey: string) {
  return z.string().trim().min(1, `${envKey} is required`)
}

function httpUrlString(envKey: string) {
  return z.url({
    error: `${envKey} must be a valid URL`,
  }).refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  }, `${envKey} must use http or https`)
}

function wsUrlString(envKey: string) {
  return z.url({
    error: `${envKey} must be a valid URL`,
  }).refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'ws:' || protocol === 'wss:'
  }, `${envKey} must use ws or wss`)
}

export const configSchema = z.object({
  openai: z.object({
    apiKey: requiredString('OPENAI_API_KEY'),
    baseUrl: httpUrlString('OPENAI_API_BASEURL'),
    model: requiredString('OPENAI_MODEL'),
    reasoningModel: requiredString('OPENAI_REASONING_MODEL'),
    /**
     * Sent as `reasoning_effort`. `low` is absent on purpose — @xsai/shared-chat
     * does not list it.
     *
     * NOTICE: `medium` is a deliberately conservative default, not the cheap one.
     *
     * Thinking is 89% of output tokens and the difference between a 2.1s turn and
     * a 12.7s one, so `none` looks strictly better — but a 2026-08-13 session
     * proved otherwise: turn rate went from 4.9/min to 37.3/min, and since the
     * brain has no minimum interval between the follow-up turns it schedules for
     * itself, the bot spammed public server chat roughly once a second. The LLM's
     * own latency had been acting as the only rate limiter.
     *
     * Removal condition: once self-triggered turns are paced (and/or trivial
     * reactions are handled by the reflex/rule layer instead of the brain), drop
     * this to `none` — the token and latency win is real and large.
     */
    reasoningEffort: z.enum(['none', 'minimal', 'medium', 'high', 'xhigh']).default('medium'),
  }),
  debug: z.object({
    mcp: z.boolean().default(false),
    server: z.boolean().default(false),
    viewer: z.boolean().default(false),
  }),
  vision: z.object({
    enabled: z.boolean().default(true),
    // Separate from the debug viewer's port so both can run side by side; this one only ever
    // serves the bot's own headless browser.
    port: z.coerce.number().int().min(1).max(65535).default(3008),
    // The third-person selfie renderer runs its own viewer feed; it needs a second port for the
    // same reason the debug viewer does — two prismarine-viewer servers cannot share one.
    selfiePort: z.coerce.number().int().min(1).max(65535).default(3009),
    // Frame size drives the model's image token cost (roughly width*height/750 tokens), so it is
    // kept modest: large enough to read block shapes, small enough to look often.
    width: z.coerce.number().int().min(160).max(1920).default(640),
    height: z.coerce.number().int().min(120).max(1080).default(400),
    // Chunks streamed around the bot. Each extra ring costs meshing time on the first look.
    viewDistance: z.coerce.number().int().min(1).max(8).default(4),
  }),
  bot: z.object({
    username: requiredString('BOT_USERNAME'),
    host: requiredString('BOT_HOSTNAME'),
    port: z.coerce
      .number({
        error: 'BOT_PORT must be a valid integer',
      })
      .int('BOT_PORT must be an integer')
      .min(1, 'BOT_PORT must be between 1 and 65535')
      .max(65535, 'BOT_PORT must be between 1 and 65535'),
    auth: z.enum(botAuthValues, {
      error: `BOT_AUTH must be one of: ${botAuthValues.join(', ')}`,
    }).optional(),
    password: z.string().optional(),
    version: z.string().trim().min(1, 'BOT_VERSION cannot be empty').optional(),
    // In-game username of the bot's owner ("主人"). Binds the relayed "主人" role to the real
    // player so the bot recognizes its master in-world (e.g. does not flee when the master hits it).
    masterUsername: z.string().trim().min(1).optional(),
  }),
  airi: z.object({
    wsBaseUrl: wsUrlString('AIRI_WS_BASEURL'),
    clientName: requiredString('AIRI_CLIENT_NAME'),
    token: z.string().optional(),
  }),
})

export type Config = z.infer<typeof configSchema>

function formatConfigValidationErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

// Default configurations
const defaultConfig: Omit<Config, 'openai'> = {
  bot: {
    username: 'airi-bot',
    host: 'localhost',
    port: 25565,
    auth: undefined,
    password: '',
    version: '1.20',
    masterUsername: undefined,
  },
  airi: {
    wsBaseUrl: 'ws://localhost:6121/ws',
    clientName: 'minecraft-bot',
    token: '',
  },
  debug: {
    mcp: false,
    server: false,
    viewer: false,
  },
  vision: {
    enabled: true,
    port: 3008,
    selfiePort: 3009,
    width: 640,
    height: 400,
    viewDistance: 4,
  },
}

// Create a singleton config instance
// openai is populated by initEnv() at startup
export const config = { ...defaultConfig } as Config

// Initialize environment configuration
export function initEnv(): void {
  logger.log('Initializing environment variables')

  const parsedConfig = configSchema.safeParse({
    openai: {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_API_BASEURL,
      model: env.OPENAI_MODEL,
      reasoningModel: env.OPENAI_REASONING_MODEL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
    },
    debug: {
      mcp: env.ENABLE_MCP_SERVER === 'true',
      server: env.ENABLE_DEBUG_SERVER === 'true',
      viewer: env.ENABLE_MINECRAFT_VIEWER === 'true',
    },
    vision: {
      // Opt-out rather than opt-in: the renderer stays dormant until the model actually looks,
      // so an unused camera costs nothing but a missing one silently blinds the bot.
      enabled: env.ENABLE_BOT_VISION !== 'false',
      port: env.BOT_VISION_PORT || defaultConfig.vision.port,
      selfiePort: env.BOT_VISION_SELFIE_PORT || defaultConfig.vision.selfiePort,
      width: env.BOT_VISION_WIDTH || defaultConfig.vision.width,
      height: env.BOT_VISION_HEIGHT || defaultConfig.vision.height,
      viewDistance: env.BOT_VISION_VIEW_DISTANCE || defaultConfig.vision.viewDistance,
    },
    bot: {
      username: env.BOT_USERNAME || defaultConfig.bot.username,
      host: env.BOT_HOSTNAME || defaultConfig.bot.host,
      port: env.BOT_PORT || defaultConfig.bot.port,
      auth: env.BOT_AUTH || defaultConfig.bot.auth,
      password: defaultConfig.bot.password,
      version: env.BOT_VERSION || defaultConfig.bot.version,
      masterUsername: env.BOT_MASTER_USERNAME || defaultConfig.bot.masterUsername,
    },
    airi: {
      wsBaseUrl: env.AIRI_WS_BASEURL ?? defaultConfig.airi.wsBaseUrl,
      clientName: env.AIRI_CLIENT_NAME ?? defaultConfig.airi.clientName,
      token: env.AIRI_WS_TOKEN || defaultConfig.airi.token,
    },
  })

  if (!parsedConfig.success) {
    logger.withFields({ issues: parsedConfig.error.issues }).error(
      `Invalid environment configuration: ${formatConfigValidationErrors(parsedConfig.error)}`,
    )
    throw parsedConfig.error
  }

  config.openai = parsedConfig.data.openai
  config.bot = parsedConfig.data.bot
  config.airi = parsedConfig.data.airi
  config.debug = parsedConfig.data.debug

  logger.withFields({
    config: {
      ...config,
      openai: { ...config.openai, apiKey: '[REDACTED]' },
      bot: { ...config.bot, password: '[REDACTED]' },
      airi: { ...config.airi, token: '[REDACTED]' },
    },
  }).log('Environment variables initialized')
}
