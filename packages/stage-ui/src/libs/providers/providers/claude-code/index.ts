import type { ProviderRuntimeValidator } from '../../types'

import { errorMessageFrom } from '@moeru/std'
import { createOpenAI } from '@xsai-ext/providers/create'
import { listModels } from '@xsai/model'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../types'
import { defineProvider } from '../registry'

const DEFAULT_PORT = 14515

function baseUrlFromPort(port: number): string {
  return `http://127.0.0.1:${port}/v1/`
}

const claudeCodeConfigSchema = z.object({
  port: z.coerce.number()
    .int()
    .min(1)
    .max(65535)
    .default(DEFAULT_PORT),
})

type ClaudeCodeConfig = z.input<typeof claudeCodeConfigSchema>

function createClaudeCodeValidators(): { validateProvider: Array<(contextOptions: { t: (s: string) => string }) => ProviderRuntimeValidator<ClaudeCodeConfig>> } {
  return {
    validateProvider: [
      ({ t }) => ({
        id: `claude-code:${ProviderValidationCheck.Connectivity}`,
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-connectivity.title'),
        schedule: { mode: 'interval' as const, intervalMs: 30_000 },
        validator: async (config) => {
          const port = Number(config.port ?? DEFAULT_PORT)
          const baseUrl = baseUrlFromPort(port)

          try {
            const modelsUrl = `${baseUrl}models`
            const response = await fetch(modelsUrl, { signal: AbortSignal.timeout(5_000) })
            if (!response.ok)
              throw new Error(`HTTP ${response.status}`)
            return { errors: [], reason: '', reasonKey: '', valid: true }
          }
          catch (error) {
            const msg = errorMessageFrom(error)
            return {
              errors: [{ error }],
              reason: `Cannot reach the Claude Code brain service at ${baseUrl}. Make sure it is running:\n\n`
                + `  pnpm -F @proj-airi/claude-code-brain dev\n\n`
                + `Error: ${msg}`,
              reasonKey: '',
              valid: false,
            }
          }
        },
      }),
      ({ t }) => ({
        id: `claude-code:${ProviderValidationCheck.ModelList}`,
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-model-list.title'),
        schedule: { mode: 'interval' as const, intervalMs: 30_000 },
        validator: async (config) => {
          const port = Number(config.port ?? DEFAULT_PORT)
          const baseUrl = baseUrlFromPort(port)

          try {
            const models = await listModels({ baseURL: baseUrl, apiKey: '' })
            if (!models || models.length === 0)
              throw new Error('No models returned')
            return { errors: [], reason: '', reasonKey: '', valid: true }
          }
          catch (error) {
            return {
              errors: [{ error }],
              reason: `Model list check failed: ${errorMessageFrom(error)}`,
              reasonKey: '',
              valid: false,
            }
          }
        },
      }),
    ],
  }
}

export const providerClaudeCode = defineProvider<ClaudeCodeConfig>({
  id: 'claude-code',
  order: 1,
  name: 'Claude Code',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.claude-code.title'),
  description: 'Use your Claude Code subscription as AIRI\'s brain via a local bridge.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.claude-code.description'),
  tasks: ['chat'],
  icon: 'i-lobe-icons:claude',
  iconColor: 'i-lobe-icons:claude-color',

  requiresCredentials: false,

  createProviderConfig: ({ t }) => claudeCodeConfigSchema.extend({
    port: claudeCodeConfigSchema.shape.port
      .meta({
        labelLocalized: t('settings.pages.providers.provider.claude-code.fields.port.label'),
        descriptionLocalized: t('settings.pages.providers.provider.claude-code.fields.port.description'),
      }),
  }),

  createProvider(config) {
    return createOpenAI('', baseUrlFromPort(Number(config.port ?? DEFAULT_PORT)))
  },

  validationRequiredWhen: () => true,
  validators: {
    validateConfig: [
      ({ t }) => ({
        id: 'claude-code:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config) => {
          const errors: Array<{ error: unknown }> = []
          const port = Number(config.port ?? DEFAULT_PORT)

          if (!Number.isFinite(port) || port < 1 || port > 65535)
            errors.push({ error: new Error('Port must be between 1 and 65535.') })

          return {
            errors,
            reason: errors.length > 0 ? errors.map(item => (item.error as Error).message).join(', ') : '',
            reasonKey: '',
            valid: errors.length === 0,
          }
        },
      }),
    ],
    ...createClaudeCodeValidators(),
  },
})
