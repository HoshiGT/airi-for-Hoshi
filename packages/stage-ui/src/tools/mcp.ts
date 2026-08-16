import type { Tool } from '@xsai/shared-chat'

import { errorMessageFromValue } from '@proj-airi/stage-shared'
import { tool } from '@xsai/tool'
import { z } from 'zod'

/**
 * Describes an MCP tool that can be exposed to the shared LLM runtime.
 *
 * Use when:
 * - A runtime needs to list available MCP tools before exposing them to models
 *
 * Expects:
 * - `name` is the fully-qualified tool name used for invocation
 *
 * Returns:
 * - The MCP tool descriptor metadata reported by the runtime
 */
export interface McpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * Payload for invoking an MCP tool through a runtime-specific transport.
 *
 * Use when:
 * - A runtime needs to forward a tool invocation into the MCP layer
 *
 * Expects:
 * - `name` matches a descriptor returned from `listTools`
 * - `arguments` is a JSON-compatible object when provided
 *
 * Returns:
 * - The MCP tool call input envelope
 */
export interface McpCallToolPayload {
  name: string
  arguments?: Record<string, unknown>
}

/**
 * Result returned from an MCP tool invocation.
 *
 * Use when:
 * - An MCP runtime returns tool output back to the shared LLM layer
 *
 * Expects:
 * - Error responses set `isError` when the tool execution failed
 *
 * Returns:
 * - Structured and unstructured MCP tool output
 */
export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
}

/**
 * Runtime contract for wiring MCP tool discovery and execution into `stage-ui`.
 *
 * Use when:
 * - A concrete runtime such as Electron needs to provide MCP access without a singleton bridge
 *
 * Expects:
 * - `listTools` and `callTool` are safe to call multiple times
 *
 * Returns:
 * - An object that can back `createMcpTools`
 */
export interface McpToolRuntime {
  listTools: () => Promise<McpToolDescriptor[]>
  callTool: (payload: McpCallToolPayload) => Promise<McpCallToolResult>
}

/**
 * MCP tools the model is never allowed to call itself, no matter which server
 * exposes them.
 *
 * These are the approval gates of `computer-use-mcp`: a risky action (running a
 * shell command, opening a PTY) does not execute, it parks as a *pending action*
 * and the approve tool is what actually runs it. Left in the model's reach that
 * gate is decorative — the model can approve the command it just proposed
 * without anyone seeing it, which is exactly what the gate exists to prevent.
 * The approval queue was built to make the model pause and to leave an audit
 * trail, not to withstand an adversary, and this character's context carries
 * untrusted text (bridged chat messages, web search results) that can ask for
 * a command in the first place.
 *
 * So approving is a *human* capability here: the host UI calls these tools
 * directly through its own {@link McpToolRuntime}, which is not filtered. Only
 * the model-facing proxy below is.
 */
const HUMAN_ONLY_MCP_TOOLS: ReadonlySet<string> = new Set([
  'desktop_approve_pending_action',
  'desktop_reject_pending_action',
])

/**
 * Strips the server prefix from a qualified MCP tool name.
 *
 * Before:
 * - "computer_use::desktop_approve_pending_action"
 *
 * After:
 * - "desktop_approve_pending_action"
 *
 * Matching on the bare tool name is deliberate: the server key is whatever the
 * user typed in their MCP settings, so gating on the qualified name would let a
 * rename re-expose the approval tools.
 */
function mcpToolNameOf(qualifiedName: string): string {
  const separator = qualifiedName.lastIndexOf('::')
  return separator === -1 ? qualifiedName : qualifiedName.slice(separator + 2)
}

/**
 * Whether a tool must be driven by the user rather than the model. Exported so
 * host UIs can label the approval affordances they own.
 */
export function isHumanOnlyMcpTool(qualifiedName: string): boolean {
  return HUMAN_ONLY_MCP_TOOLS.has(mcpToolNameOf(qualifiedName))
}

/**
 * Creates MCP proxy tools backed by a runtime-provided transport.
 *
 * Use when:
 * - A runtime wants to register MCP tools into the shared LLM tool store
 *
 * Expects:
 * - The runtime implements the `McpToolRuntime` contract
 *
 * Returns:
 * - xsai tool definition promises for MCP listing and invocation
 *
 * The returned tools are the *model's* view of MCP and are filtered by
 * {@link isHumanOnlyMcpTool}. A host that needs the full surface (to execute an
 * approval the user just clicked) should call its `McpToolRuntime` directly
 * instead of going through these.
 */
export function createMcpTools(runtime: McpToolRuntime): Array<Promise<Tool>> {
  return [
    tool({
      name: 'builtIn_mcpListTools',
      description: 'List all available MCP tools. Call this first to discover tool names before calling builtIn_mcpCallTool.',
      execute: async () => {
        try {
          const tools = await runtime.listTools()
          return tools.filter(descriptor => !isHumanOnlyMcpTool(descriptor.name))
        }
        catch (error) {
          console.warn('[builtIn_mcpListTools] failed to list tools:', error)
          return ''
        }
      },
      parameters: z.object({}).strict(),
    }),
    tool({
      name: 'builtIn_mcpCallTool',
      description: 'Call an MCP tool by name. Use builtIn_mcpListTools first to get available tool names.',
      execute: async ({ name, arguments: argsJson }) => {
        // Hiding these from the listing is not enough on its own: the pending
        // response the model just received names the approval tool and quotes
        // the id to pass it, so the name is right there in its context.
        if (isHumanOnlyMcpTool(name)) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `${name} can only be run by the user, not by you. This action is waiting for their approval: show them the exact command you want to run and why, then wait. They approve it in the chat; you will get the result once they do.`,
            }],
          }
        }

        try {
          const args = argsJson ? JSON.parse(argsJson) : {}
          return await runtime.callTool({ name, arguments: args })
        }
        catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: errorMessageFromValue(error) }],
          }
        }
      },
      // NOTICE: `arguments` is z.string() (JSON) because z.unknown() produces `{}` (no `type` key)
      // and z.record() emits `propertyNames`, both rejected by OpenAI.
      parameters: z.object({
        name: z.string().describe('Tool name in "<serverName>::<toolName>" format'),
        arguments: z.string().describe('JSON object of tool arguments, e.g. {"query":"hello","limit":10}'),
      }).strict(),
    }),
  ]
}

function createUnavailableMcpToolRuntime(): McpToolRuntime {
  return {
    async listTools() {
      throw new Error('MCP tools are not available in this runtime.')
    },
    async callTool() {
      throw new Error('MCP tools are not available in this runtime.')
    },
  }
}

/**
 * Builds the default stage-ui MCP tool set without depending on runtime singletons.
 *
 * Use when:
 * - Shared code needs the MCP tool schema before a concrete runtime registers live implementations
 *
 * Expects:
 * - Runtime-specific callers override these tools through `useLlmToolsStore`
 *
 * Returns:
 * - MCP tool definitions with an unavailable-runtime fallback
 */
export async function mcp(): Promise<Tool[]> {
  return await Promise.all(createMcpTools(createUnavailableMcpToolRuntime()))
}
