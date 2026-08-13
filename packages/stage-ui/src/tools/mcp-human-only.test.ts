import type { Tool } from '@xsai/shared-chat'

import type { McpToolDescriptor, McpToolRuntime } from './mcp'

import { describe, expect, it, vi } from 'vitest'

import { createMcpTools, isHumanOnlyMcpTool } from './mcp'

const ctx = { messages: [], toolCallId: 'test' }

function descriptor(name: string): McpToolDescriptor {
  const [serverName, toolName] = name.split('::')
  return {
    serverName: toolName ? serverName : '',
    name,
    toolName: toolName ?? name,
    inputSchema: { type: 'object' },
  }
}

function createRuntime(overrides: Partial<McpToolRuntime> = {}) {
  return {
    listTools: vi.fn<McpToolRuntime['listTools']>().mockResolvedValue([]),
    callTool: vi.fn<McpToolRuntime['callTool']>().mockResolvedValue({ content: [] }),
    ...overrides,
  }
}

async function mountTools(runtime: McpToolRuntime) {
  const tools = await Promise.all(createMcpTools(runtime))
  const byName = new Map(tools.map(tool => [(tool as Tool).function.name, tool]))
  return {
    list: byName.get('builtIn_mcpListTools')!,
    call: byName.get('builtIn_mcpCallTool')!,
  }
}

describe('isHumanOnlyMcpTool', () => {
  it('matches the approval gates whatever the user named the server', () => {
    expect(isHumanOnlyMcpTool('computer_use::desktop_approve_pending_action')).toBe(true)
    expect(isHumanOnlyMcpTool('my_renamed_server::desktop_approve_pending_action')).toBe(true)
    expect(isHumanOnlyMcpTool('desktop_approve_pending_action')).toBe(true)
    expect(isHumanOnlyMcpTool('computer_use::desktop_reject_pending_action')).toBe(true)
  })

  it('leaves every other tool alone, including the one that needs approving', () => {
    expect(isHumanOnlyMcpTool('computer_use::terminal_exec')).toBe(false)
    expect(isHumanOnlyMcpTool('computer_use::desktop_click')).toBe(false)
    expect(isHumanOnlyMcpTool('other::search')).toBe(false)
  })
})

describe('createMcpTools human-only gate', () => {
  it('hides the approval tools from the listing the model discovers', async () => {
    const runtime = createRuntime({
      listTools: vi.fn<McpToolRuntime['listTools']>().mockResolvedValue([
        descriptor('computer_use::terminal_exec'),
        descriptor('computer_use::desktop_approve_pending_action'),
        descriptor('computer_use::desktop_reject_pending_action'),
      ]),
    })
    const { list } = await mountTools(runtime)

    const result = await list.execute({}, ctx) as McpToolDescriptor[]

    expect(result.map(entry => entry.name)).toEqual(['computer_use::terminal_exec'])
  })

  it('refuses the call even though the model can read the tool name off the pending response', async () => {
    // ROOT CAUSE:
    //
    // The approval response quotes both the approve tool's name and the pending
    // action id, so filtering the listing alone leaves the model everything it
    // needs to call it anyway — and computer-use-mcp's approve handler executes
    // the parked action with `skipApprovalQueue: true`, no human involved.
    //
    // The gate therefore lives on the call path too, not only on discovery.
    const runtime = createRuntime()
    const { call } = await mountTools(runtime)

    const result = await call.execute({
      name: 'computer_use::desktop_approve_pending_action',
      arguments: '{"id":"pending-1"}',
    }, ctx) as { isError?: boolean, content: { text: string }[] }

    expect(result.isError).toBe(true)
    expect(runtime.callTool).not.toHaveBeenCalled()
    // The refusal has to teach the next move, or the model just retries.
    expect(result.content[0].text).toContain('can only be run by the user')
    expect(result.content[0].text).toContain('show them the exact command')
  })

  it('still forwards the tool that parks the pending action', async () => {
    const runtime = createRuntime()
    const { call } = await mountTools(runtime)

    await call.execute({
      name: 'computer_use::terminal_exec',
      arguments: '{"command":"ls -la"}',
    }, ctx)

    expect(runtime.callTool).toHaveBeenCalledWith({
      name: 'computer_use::terminal_exec',
      arguments: { command: 'ls -la' },
    })
  })
})
