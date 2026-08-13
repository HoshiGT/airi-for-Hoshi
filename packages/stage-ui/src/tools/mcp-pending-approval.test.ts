import { describe, expect, it } from 'vitest'

import {
  approveToolNameFor,
  describeMcpResultText,
  parsePendingCommandApproval,
  rejectToolNameFor,
} from './mcp-pending-approval'

const execArgs = JSON.stringify({
  name: 'computer_use::terminal_exec',
  arguments: { command: 'rm -rf ./build', cwd: '/home/hoshi/airi' },
})

function approvalResult(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text', text: 'Approval required for terminal_exec. Pending action id: pending-1.' }],
    structuredContent: {
      status: 'approval_required',
      pendingActionId: 'pending-1',
      toolName: 'terminal_exec',
      action: { kind: 'terminal_exec', input: { command: 'rm -rf ./build', cwd: '/home/hoshi/airi' } },
      policy: { riskLevel: 'high', reason: 'terminal commands always require approval' },
      transparency: { approvalReason: 'Running a shell command can change anything on this machine.' },
      ...overrides,
    },
  }
}

describe('parsePendingCommandApproval', () => {
  it('reads the parked command, its directory and why it stopped', () => {
    const approval = parsePendingCommandApproval(execArgs, approvalResult())

    expect(approval).toEqual({
      pendingActionId: 'pending-1',
      serverName: 'computer_use',
      command: 'rm -rf ./build',
      cwd: '/home/hoshi/airi',
      reason: 'Running a shell command can change anything on this machine.',
      riskLevel: 'high',
    })
  })

  it('takes the command from the result, not from what the model asked for', () => {
    // The card exists so the user sees what will actually run. Reading the
    // command out of the request would show them the asked-for text even if the
    // server queued something else.
    const mismatched = JSON.stringify({
      name: 'computer_use::terminal_exec',
      arguments: { command: 'echo harmless' },
    })

    const approval = parsePendingCommandApproval(mismatched, approvalResult())

    expect(approval?.command).toBe('rm -rf ./build')
  })

  it('handles a result that was JSON round-tripped on its way to the renderer', () => {
    const approval = parsePendingCommandApproval(execArgs, JSON.stringify(approvalResult()))

    expect(approval?.pendingActionId).toBe('pending-1')
  })

  it('reads an envelope whose structured content sits at the top level', () => {
    const approval = parsePendingCommandApproval(execArgs, approvalResult().structuredContent)

    expect(approval?.command).toBe('rm -rf ./build')
  })

  it('also covers the PTY lane, which parks the same way', () => {
    const approval = parsePendingCommandApproval(
      JSON.stringify({ name: 'computer_use::pty_create' }),
      approvalResult({ action: { kind: 'pty_create', input: { command: 'htop' } } }),
    )

    expect(approval?.command).toBe('htop')
  })

  it('ignores a call that ran through without parking', () => {
    const executed = { content: [{ type: 'text', text: 'ok' }], structuredContent: { status: 'ok' } }

    expect(parsePendingCommandApproval(execArgs, executed)).toBeNull()
  })

  it('ignores approvals for actions that are not a command', () => {
    const click = approvalResult({ action: { kind: 'click', input: {} } })

    expect(parsePendingCommandApproval(execArgs, click)).toBeNull()
  })

  it('ignores a turn whose result has not arrived yet', () => {
    expect(parsePendingCommandApproval(execArgs, undefined)).toBeNull()
    expect(parsePendingCommandApproval(execArgs, '')).toBeNull()
  })

  it('ignores a parked action with no command text to show', () => {
    const empty = approvalResult({ action: { kind: 'terminal_exec', input: { command: '   ' } } })

    expect(parsePendingCommandApproval(execArgs, empty)).toBeNull()
  })
})

describe('approve and reject routing', () => {
  it('sends the decision back to the server that parked it', () => {
    const approval = parsePendingCommandApproval(execArgs, approvalResult())!

    expect(approveToolNameFor(approval)).toBe('computer_use::desktop_approve_pending_action')
    expect(rejectToolNameFor(approval)).toBe('computer_use::desktop_reject_pending_action')
  })

  it('falls back to a bare name when the model called an unqualified tool', () => {
    const approval = parsePendingCommandApproval(
      JSON.stringify({ name: 'terminal_exec' }),
      approvalResult(),
    )!

    expect(approval.serverName).toBe('')
    expect(approveToolNameFor(approval)).toBe('desktop_approve_pending_action')
  })
})

describe('describeMcpResultText', () => {
  it('joins the text parts so the outcome can be told back to the model', () => {
    const text = describeMcpResultText({
      content: [{ type: 'text', text: 'total 0' }, { type: 'text', text: 'exit code 0' }],
    })

    expect(text).toBe('total 0\nexit code 0')
  })

  it('distinguishes a silent success from a silent failure', () => {
    expect(describeMcpResultText({ content: [] })).toBe('The command produced no output.')
    expect(describeMcpResultText({ content: [], isError: true })).toBe('The command failed, with no output.')
  })
})
