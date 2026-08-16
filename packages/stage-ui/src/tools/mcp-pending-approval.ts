/**
 * Reading `computer-use-mcp`'s approval protocol off a `builtIn_mcpCallTool`
 * turn, so the chat surface can render the parked command and let the user
 * decide.
 *
 * Every MCP call the model makes arrives in chat as the same
 * `builtIn_mcpCallTool` tool-call, so which underlying tool ran — and whether it
 * stopped for approval — is only knowable by parsing the argument and result
 * payloads. That parsing is the decision this module owns; the renderer stays a
 * dumb view over {@link PendingCommandApproval}.
 */

/** Approve/reject tool names, appended to the server key the call was routed to. */
const APPROVE_TOOL = 'desktop_approve_pending_action'
const REJECT_TOOL = 'desktop_reject_pending_action'

/**
 * Action kinds whose approval this surface renders as a command card.
 *
 * Other kinds also park for approval (clicks, typing, clipboard reads); they are
 * left to the generic tool-call block because a command line is the case where
 * seeing the literal text before it runs is the whole point.
 */
const COMMAND_ACTION_KINDS = new Set(['terminal_exec', 'pty_create'])

/** A parked command waiting on the user, with everything needed to resolve it. */
export interface PendingCommandApproval {
  pendingActionId: string
  /**
   * MCP server key this call was routed to, carried so the approve call goes
   * back to the same server. Empty when the model called an unqualified name.
   */
  serverName: string
  /** Literal command text — the thing the user is actually being asked about. */
  command: string
  /** Working directory the command would run in, when the call named one. */
  cwd?: string
  /** Policy's own words on why this needs a human. */
  reason?: string
  riskLevel?: string
}

interface ApprovalStructuredContent {
  status?: string
  pendingActionId?: string
  action?: {
    kind?: string
    input?: { command?: string, cwd?: string }
  }
  policy?: { riskLevel?: string, reason?: string }
  transparency?: { approvalReason?: string }
}

function parseObject<T extends object>(value: unknown): T | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    }
    catch {
      return null
    }
  }
  if (value && typeof value === 'object')
    return value as T
  return null
}

/**
 * Digs the MCP payload out of whatever the chat layer stored as the tool result.
 *
 * Results reach the renderer having possibly been JSON round-tripped, and the
 * MCP envelope may sit either at the top level or nested under `structuredContent`
 * depending on how the runtime forwarded it, so probe both rather than assuming.
 */
function structuredContentOf(result: unknown): ApprovalStructuredContent | null {
  const parsed = parseObject<{ structuredContent?: unknown } & ApprovalStructuredContent>(result)
  if (!parsed)
    return null

  const nested = parseObject<ApprovalStructuredContent>(parsed.structuredContent)
  if (nested?.status)
    return nested

  return parsed.status ? parsed : null
}

/**
 * The server key from a qualified MCP tool name, or `''` when unqualified.
 *
 * Before:
 * - "computer_use::terminal_exec"
 *
 * After:
 * - "computer_use"
 */
function serverNameOf(qualifiedName: string): string {
  const separator = qualifiedName.lastIndexOf('::')
  return separator === -1 ? '' : qualifiedName.slice(0, separator)
}

/**
 * Reads a `builtIn_mcpCallTool` turn as a parked command, or returns null when
 * the turn is anything else — a different tool, a call that ran straight
 * through, or a result that has not arrived yet.
 *
 * `args` is the model's `{ name, arguments }` payload and supplies only the
 * server key; the command itself is taken from the result, which is the MCP
 * server's own account of what it parked. Trusting the arguments for that would
 * let a mismatch between what was asked and what was queued go unnoticed —
 * exactly the thing the user is being shown the card to catch.
 */
export function parsePendingCommandApproval(args: string, result: unknown): PendingCommandApproval | null {
  const structured = structuredContentOf(result)
  if (structured?.status !== 'approval_required')
    return null

  const { pendingActionId, action } = structured
  if (!pendingActionId || !action?.kind || !COMMAND_ACTION_KINDS.has(action.kind))
    return null

  const command = action.input?.command?.trim()
  if (!command)
    return null

  const parsedArgs = parseObject<{ name?: string }>(args)

  return {
    pendingActionId,
    serverName: serverNameOf(parsedArgs?.name ?? ''),
    command,
    cwd: action.input?.cwd,
    reason: structured.transparency?.approvalReason ?? structured.policy?.reason,
    riskLevel: structured.policy?.riskLevel,
  }
}

/** Qualified name of the approve tool for the server that parked the action. */
export function approveToolNameFor(approval: PendingCommandApproval): string {
  return approval.serverName ? `${approval.serverName}::${APPROVE_TOOL}` : APPROVE_TOOL
}

/** Qualified name of the reject tool for the server that parked the action. */
export function rejectToolNameFor(approval: PendingCommandApproval): string {
  return approval.serverName ? `${approval.serverName}::${REJECT_TOOL}` : REJECT_TOOL
}

/**
 * Flattens an MCP result into the text the model should see after the user
 * decides, since the decision happens outside the model's turn and has to be
 * reported back to it as ordinary conversation.
 */
export function describeMcpResultText(result: unknown): string {
  const parsed = parseObject<{ content?: { type?: string, text?: string }[], isError?: boolean }>(result)
  const text = parsed?.content
    ?.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()

  if (text)
    return text

  return parsed?.isError ? 'The command failed, with no output.' : 'The command produced no output.'
}
