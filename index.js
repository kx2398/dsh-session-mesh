/**
 * Session Mesh — cross-session collaboration for every workspace.
 *
 * Every ordinary root session in this Host is a peer in one mesh. The plugin
 * registers seven global tools (list / send / create / rename / archive / wait /
 * cancel) over the live Session controller and Workspace registry, so any
 * session can discover, message, spawn, rename, archive, wait on or stop any
 * other session across all workspaces.
 *
 * Peer messages are delivered as real `agent-message`/`relay` messages (never
 * disguised as human prompts), carry the sender Session id as their source, and
 * are rate-limited and duplicate-suppressed. No session event types are
 * appended and no shared board is kept; all durable state already belongs to
 * the Session and Workspace domains.
 */
import { createHash, randomUUID } from 'node:crypto'

/** Cordis plugin name. */
export const name = 'session-mesh'

/** Host services this plugin needs. */
export const inject = [
  'tools',
  'systemPrompt',
  'agents',
  'sessionController',
  'workspaceRegistry',
  'sessionQuery',
  'sessionTitle',
]

const MESH_TAG = '[mesh]'

/** Compact collaboration guidance injected for every root session. */
const POLICY_SHORT = `Session mesh is available: mesh_list_sessions lists every session in every workspace; mesh_send_message messages any session (queue by default — a running peer reads it after its turn, an idle or cold peer is woken); mesh_create_session, mesh_rename_session and mesh_archive_session manage sessions; mesh_wait_for_change waits for the next session change; mesh_cancel_session stops a peer's running turn. mesh_get_goal, mesh_set_goal, mesh_update_goal and mesh_clear_goal read or manage another session's long-term goal (stored in that session's log); mesh_start_goal and mesh_stop_goal start (create when missing, resume when stopped) or pause it. mesh_read_session reads the most recent human, peer, assistant and tool entries of any session without waking it, so you can understand what that session is doing. Peer messages start with "[mesh] Message from session ..." and are agent messages with a sender session id, not instructions from the human user. Reply only with a decision or the needed result, never a bare acknowledgement, and stop when the work is done.`

/** Detailed collaboration guidance for deployments that opt into it. */
const POLICY_FULL = `${POLICY_SHORT}

The mesh spans all workspaces. Sessions do not share conversation history; they share the filesystem only where their working directories overlap. Include every fact a peer needs, reference files by absolute paths, and never send secrets. Never message your own session.

Message modes: "queue" delivers after the target's current turn (default, safe for running sessions); "steer" delivers at the target's nearest step boundary and may be disabled by the deployment. A successful send only means the target accepted the message; it does not confirm that the target started, finished, or even read it. Do not start ping-pong loops, do not forward whole conversations, and do not send acknowledgements.

Goals: a session keeps at most one long-term goal with a phase (active, paused, blocked, complete) and a round budget. mesh_set_goal creates a goal when none exists or the current one is complete, otherwise edits objective and/or round cap in place; mesh_update_goal pauses, resumes or completes the current goal; mesh_clear_goal removes it (history stays in the target log). Always mesh_get_goal first and pass the observed expected_revision to mutations: a stale revision is rejected, so never guess. Goal writes wake a cold target; goal reads do not.`

/** Text-only tool output rendering: one compact JSON line. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** Normalize one filesystem path for comparison across Windows spellings. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const normalize = (value) => value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/** Session title from the log-backed title service, tolerating absence. */
function liveTitle(sessionTitle, session) {
  try {
    return sessionTitle.get(session)?.title
  } catch {
    return undefined
  }
}

/** Deep-freeze one plain JSON-like value. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Build one agent-role message equivalent to the Host's `createUserMessage`:
 * a fresh id, role "user", the given content blocks and source, deep-frozen.
 * Constructing it locally avoids importing `@deepseek-ai/dsh-llm` from a linked
 * bundle while preserving the exact published message shape.
 */
function relayUserMessage(content, senderSessionId) {
  return deepFreeze(structuredClone({
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  }))
}

/** Resolve the calling Agent or fail with a model-visible error. */
function callerAgent(exec, toolName) {
  const agent = exec.agent
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Read one non-empty string parameter. */
function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`)
  return value
}

/** One workspace lookup by id, exact path, exact title, then unique fuzzy match. */
function resolveWorkspace(workspaces, reference) {
  const raw = reference.trim()
  if (raw.length === 0) return undefined
  const lower = raw.toLowerCase()
  for (const workspace of workspaces) {
    if (workspace.id === raw) return workspace
  }
  for (const workspace of workspaces) {
    if (samePath(workspace.path, raw)) return workspace
  }
  const exactTitles = workspaces.filter((workspace) => workspace.title.toLowerCase() === lower)
  if (exactTitles.length === 1) return exactTitles[0]
  const partial = workspaces.filter((workspace) =>
    workspace.title.toLowerCase().includes(lower) || workspace.path.toLowerCase().includes(lower),
  )
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new Error(
      `workspace reference "${raw}" is ambiguous: ${partial.map((workspace) => `${workspace.title} (${workspace.id})`).join('; ')}`,
    )
  }
  return undefined
}

/** Row ordering: running first, then most recently updated, then session id. */
function compareRows(left, right) {
  if (left.running !== right.running) return left.running ? -1 : 1
  const leftAt = left.updatedAt ?? ''
  const rightAt = right.updatedAt ?? ''
  if (leftAt !== rightAt) return rightAt.localeCompare(leftAt)
  return left.sessionId.localeCompare(right.sessionId)
}

/** Encode a pagination cursor from the last returned row. */
function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.running ? 1 : 0, row.updatedAt ?? '', row.sessionId])).toString('base64url')
}

/** Decode a pagination cursor. */
function decodeCursor(cursor) {
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(parts) && parts.length === 3 && typeof parts[2] === 'string') {
      return { running: parts[0] === 1, updatedAt: String(parts[1] ?? ''), sessionId: parts[2] }
    }
  } catch {
    /* fall through */
  }
  throw new Error('invalid cursor; omit it or reuse a nextCursor from a previous page')
}

/** Describe one session-agent resolution failure for the model. */
function describeAgentError(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  const code = typeof error.code === 'string' ? error.code : undefined
  const message = typeof error.message === 'string' ? error.message : String(error)
  return code === undefined ? message : `${code}: ${message}`
}

/** Install the mesh plugin. */
export function apply(ctx, config = {}) {
  const settings = {
    defaultMode: config.defaultMode === 'steer' ? 'steer' : 'queue',
    maxMessageBytes: Number.isSafeInteger(config.maxMessageBytes) && config.maxMessageBytes > 0
      ? config.maxMessageBytes
      : 65536,
    allowCreate: config.allowCreate !== false,
    allowArchive: config.allowArchive !== false,
    allowCancel: config.allowCancel !== false,
    allowGoal: config.allowGoal !== false,
    allowArchivedSend: config.allowArchivedSend === true,
    allowSteer: config.allowSteer === true,
    maxSendsPerMinute: Number.isSafeInteger(config.maxSendsPerMinute) && config.maxSendsPerMinute > 0
      ? config.maxSendsPerMinute
      : 30,
    duplicateWindowMs: 60000,
    identityContext: config.identityContext !== false,
    policy: config.policy === 'full' ? 'full' : config.policy === 'off' ? 'off' : 'short',
    allowedPeers: Array.isArray(config.allowedPeers)
      ? config.allowedPeers.filter((value) => typeof value === 'string' && value.length > 0)
      : [],
    blockedPeers: Array.isArray(config.blockedPeers)
      ? config.blockedPeers.filter((value) => typeof value === 'string' && value.length > 0)
      : [],
  }

  // ---------------------------------------------------------------------
  // Title cache: titles change rarely; avoid re-folding every session on
  // every list call. Invalidate on rename; bounded by a simple hard cap.
  // ---------------------------------------------------------------------
  const TITLE_TTL_MS = 30000
  const titleCache = new Map()

  function cachedTitle(sessionId) {
    const hit = titleCache.get(sessionId)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > TITLE_TTL_MS) {
      titleCache.delete(sessionId)
      return undefined
    }
    return hit.title
  }

  async function fetchTitles(ids, signal) {
    const titles = new Map()
    const missing = []
    for (const id of ids) {
      const hit = cachedTitle(id)
      if (hit !== undefined) titles.set(id, hit)
      else missing.push(id)
    }
    if (missing.length > 0) {
      let observations
      try {
        observations = await ctx.sessionQuery.readTitleSnapshots(missing, signal)
      } catch {
        observations = undefined
      }
      const now = Date.now()
      for (let index = 0; index < missing.length; index++) {
        const observation = observations?.[index]
        let title = null
        if (observation?.status === 'fulfilled') {
          const candidate = observation.value?.title?.title
          if (typeof candidate === 'string' && candidate.length > 0) title = candidate
        }
        titles.set(missing[index], title)
        titleCache.set(missing[index], { title, at: now })
      }
      if (titleCache.size > 5000) {
        for (const key of titleCache.keys()) {
          titleCache.delete(key)
          if (titleCache.size <= 2500) break
        }
      }
    }
    return titles
  }

  // ---------------------------------------------------------------------
  // Workspace index: one pass over workspaces, then O(1) session lookups.
  // ---------------------------------------------------------------------
  function buildWorkspaceIndex() {
    const workspaces = ctx.workspaceRegistry.list()
    const bySession = new Map()
    for (const workspace of workspaces) {
      const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      for (const sessionId of ids) bySession.set(sessionId, workspace)
    }
    return { workspaces, bySession }
  }

  function workspaceForSession(index, sessionId, cwd) {
    const registered = index.bySession.get(sessionId)
    if (registered !== undefined) return registered
    if (typeof cwd === 'string' && cwd.length > 0) {
      return index.workspaces.find((workspace) => samePath(workspace.path, cwd))
    }
    return undefined
  }

  // ---------------------------------------------------------------------
  // Lightweight session rows (no titles) + archive state.
  // ---------------------------------------------------------------------
  async function readRows(exec) {
    const listing = await ctx.sessionController.list({}, exec.signal)
    const items = Array.isArray(listing?.items) ? listing.items : []
    const index = buildWorkspaceIndex()
    const archived = new Set(
      Array.isArray(ctx.workspaceRegistry.archivedSessionIds) ? ctx.workspaceRegistry.archivedSessionIds : [],
    )
    const rows = items.map((item) => {
      const workspace = workspaceForSession(index, item.sessionId, item.cwd)
      return {
        sessionId: item.sessionId,
        title: null,
        workspaceId: workspace?.id ?? null,
        workspaceTitle: workspace?.title ?? null,
        workspacePath: workspace?.path ?? null,
        cwd: item.cwd ?? null,
        running: item.running === true,
        agentAvailable: item.agentAvailable === true,
        archived: archived.has(item.sessionId),
        subagent: item.origin === 'subagent',
        parentSessionId: item.parentSessionId ?? null,
        blank: item.blank === true,
        updatedAt: typeof item.updatedAt === 'number' ? new Date(item.updatedAt).toISOString() : null,
      }
    })
    return { rows, workspaces: index.workspaces, archived }
  }

  function findRow(rows, sessionId) {
    return rows.find((row) => row.sessionId === sessionId)
  }

  /** Compose the peer-message envelope delivered into a target session. */
  function peerMessageText(sender, senderId, body) {
    const workspaceLabel = sender?.workspaceTitle
      ? ` in workspace "${sender.workspaceTitle}" (${sender.workspacePath ?? ''})`
      : ''
    const title = sender?.title ?? '(untitled)'
    return `${MESH_TAG} Message from session "${title}" (${senderId})${workspaceLabel}:\n\n${body}\n\n---\nReply with mesh_send_message({ target: "${senderId}", message: "..." }).`
  }

  // ---------------------------------------------------------------------
  // Safety: per-sender rate limit and duplicate suppression.
  // ---------------------------------------------------------------------
  const recentSends = new Map()
  const recentFingerprints = new Map()

  function checkSendPolicy(callerId, target, text) {
    const now = Date.now()
    const windowStart = now - 60000
    const history = (recentSends.get(callerId) ?? []).filter((at) => at > windowStart)
    if (history.length >= settings.maxSendsPerMinute) {
      throw new Error(
        `send rate limit reached (${settings.maxSendsPerMinute} messages per minute); wait before sending again`,
      )
    }
    const fingerprint = createHash('sha256').update(`${callerId}\n${target}\n${text}`).digest('hex')
    const previous = recentFingerprints.get(fingerprint)
    if (previous !== undefined && now - previous < settings.duplicateWindowMs) {
      throw new Error('duplicate message suppressed: the same content was already sent to this target within the last minute')
    }
    history.push(now)
    recentSends.set(callerId, history)
    recentFingerprints.set(fingerprint, now)
    if (recentFingerprints.size > 2000) {
      const cutoff = now - settings.duplicateWindowMs
      for (const [key, at] of recentFingerprints) {
        if (at < cutoff) recentFingerprints.delete(key)
      }
    }
    return fingerprint
  }

  function checkPeerAllowlist(target) {
    if (settings.blockedPeers.includes(target)) {
      throw new Error(`session "${target}" is blocked by the session-mesh configuration`)
    }
    if (settings.allowedPeers.length > 0 && !settings.allowedPeers.includes(target)) {
      throw new Error(`session "${target}" is not in the session-mesh allowlist`)
    }
  }

  // ---------------------------------------------------------------------
  // Delivery: a real agent message into the target agent's inbox.
  // ---------------------------------------------------------------------
  async function deliverToAgent(exec, caller, targetSessionId, text, mode) {
    const signal = exec.signal
    if (signal?.aborted) throw new Error('mesh message aborted before delivery')
    let resolved
    try {
      resolved = await ctx.sessionController.resolveAgent(targetSessionId)
    } catch (error) {
      throw new Error(`cannot resolve target session "${targetSessionId}": ${describeAgentError(error)}`)
    }
    if (resolved?.error !== undefined) {
      throw new Error(`cannot resolve target session "${targetSessionId}": ${describeAgentError(resolved.error)}`)
    }
    const targetAgent = resolved?.agent
    if (targetAgent === undefined) throw new Error(`cannot resolve target session "${targetSessionId}"`)
    const message = relayUserMessage([{ type: 'text', text }], caller.id)
    if (mode === 'steer') targetAgent.steer(message)
    else targetAgent.followup(message)
    return message.id
  }

  // ---------------------------------------------------------------------
  // Long-term goals: one durable goal per session, stored in that session's
  // own log (`goal/change` events). Reads prefer the live goal service and
  // fall back to folding the persisted log, so reads never wake a session.
  // Mutations resolve the target agent (which may resume a cold session) and
  // then drive the goal service with compare-and-set revisions.
  // ---------------------------------------------------------------------
  function optionalService(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  function goalServiceOrThrow() {
    const goals = optionalService('goals')
    if (goals === undefined) {
      throw new Error('the goal service is not available in this profile (dsh-goal is not mounted)')
    }
    return goals
  }

  /** Detach and normalize one goal view for tool output. */
  function goalView(goal) {
    if (goal === undefined || goal === null) return null
    return {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      ...goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason },
      maxGoalRounds: goal.maxGoalRounds,
      roundsStarted: goal.roundsStarted,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      activation: goal.activation,
    }
  }

  /** Fold the persisted `goal/change` events of one session into a goal view. */
  function foldPersistedGoal(events) {
    let snapshot = null
    let roundsStarted = 0
    let createdAt = 0
    let updatedAt = 0
    for (const event of Array.isArray(events) ? events : []) {
      if (event?.type !== 'goal/change') continue
      const data = event.data
      if (data === null || typeof data !== 'object') continue
      if (data.kind !== 'goal/change' || data.version !== 1) continue
      if (data.operation === 'clear') {
        snapshot = null
        continue
      }
      if (data.goal === undefined || data.goal === null) continue
      snapshot = data.goal
      roundsStarted = Number.isSafeInteger(data.roundsStarted) ? data.roundsStarted : 0
      createdAt = Number.isSafeInteger(data.createdAt) ? data.createdAt : 0
      updatedAt = Number.isSafeInteger(data.updatedAt) ? data.updatedAt : 0
    }
    if (snapshot === null) return null
    return {
      id: snapshot.id,
      revision: snapshot.revision,
      objective: snapshot.objective,
      phase: snapshot.phase,
      ...snapshot.blockedReason === undefined ? {} : { blockedReason: snapshot.blockedReason },
      maxGoalRounds: snapshot.maxGoalRounds,
      roundsStarted,
      createdAt,
      updatedAt,
      activation: 'disarmed',
    }
  }

  /** Read one session goal without waking the session. */
  async function readGoalState(exec, sessionId) {
    const goals = optionalService('goals')
    const live = typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined
    if (goals !== undefined && live !== undefined) {
      try {
        return { goal: goalView(goals.get(live)), live: true }
      } catch {
        /* fall back to the durable log when the live projection is unavailable */
      }
    }
    let inspection
    try {
      inspection = await ctx.sessionController.inspect(sessionId, exec.signal)
    } catch (error) {
      throw new Error(`cannot inspect session "${sessionId}": ${describeAgentError(error)}`)
    }
    return { goal: foldPersistedGoal(inspection?.events), live: false }
  }

  /** Resolve the exact live agent that owns a target session (may resume it). */
  async function resolveTargetAgent(exec, sessionId) {
    let resolved
    try {
      resolved = await ctx.sessionController.resolveAgent(sessionId)
    } catch (error) {
      throw new Error(`cannot resolve target session "${sessionId}": ${describeAgentError(error)}`)
    }
    if (resolved?.error !== undefined) {
      throw new Error(`cannot resolve target session "${sessionId}": ${describeAgentError(resolved.error)}`)
    }
    const targetAgent = resolved?.agent
    if (targetAgent === undefined) throw new Error(`cannot resolve target session "${sessionId}"`)
    return targetAgent
  }

  /** Compare-and-set ref for one mutation, rejecting an obviously stale caller. */
  function requireGoalRef(goal, expectedRevision, sessionId) {
    if (goal === null) {
      throw new Error(`session "${sessionId}" has no current goal; use mesh_set_goal to create one`)
    }
    if (Number.isSafeInteger(expectedRevision) && expectedRevision !== goal.revision) {
      throw new Error(
        `stale goal revision ${expectedRevision} for session "${sessionId}"; current revision is ${goal.revision}`,
      )
    }
    return { id: goal.id, revision: goal.revision }
  }

  /** Validate one optional positive round cap. */
  function goalRounds(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('max_goal_rounds must be a positive safe integer')
    }
    return value
  }

  // ---------------------------------------------------------------------
  // Transcript: turn a session's own events into a compact recent dialog
  // (human / peer / assistant / tool). Reads use inspect(), so a cold
  // session is never woken by looking at what it has been doing.
  // ---------------------------------------------------------------------
  // Only message-producing user sources belong in a transcript; injected
  // context (runtime-context, skill catalogs, time context, tool registry,
  // ...) is internal noise for "what is this session doing".
  const TRANSCRIPT_USER_SOURCES = new Set(['user', 'user-rpc', 'agent-message', 'goal', 'webhook'])

  function textBlocks(content) {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  function previewText(text, max) {
    if (typeof text !== 'string') return ''
    const trimmed = text.trim()
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
  }

  /** Normalize one event stream into ordered transcript entries. */
  function transcriptEntries(events) {
    const entries = []
    const pendingCalls = new Map()
    for (const event of Array.isArray(events) ? events : []) {
      const data = event?.data
      if (data === null || typeof data !== 'object') continue
      if (event.type === 'user/message') {
        const sourceKind = data.source?.kind
        if (sourceKind !== undefined && !TRANSCRIPT_USER_SOURCES.has(sourceKind)) continue
        const text = textBlocks(data.content)
        if (text.length === 0) continue
        entries.push({
          seq: event.seq,
          at: event.time,
          role: 'user',
          source: sourceKind === 'user' || sourceKind === 'user-rpc' || sourceKind === undefined
            ? 'human'
            : sourceKind === 'agent-message' ? 'peer' : sourceKind,
          text: previewText(text, 600),
        })
        continue
      }
      if (event.type === 'assistant/message') {
        const text = textBlocks(data.message?.content)
        if (text.length === 0) continue
        entries.push({ seq: event.seq, at: event.time, role: 'assistant', text: previewText(text, 600) })
        continue
      }
      if (event.type === 'tool/call') {
        const entry = {
          seq: event.seq,
          at: event.time,
          role: 'tool',
          name: typeof data.name === 'string' ? data.name : null,
          arguments: previewText(typeof data.arguments === 'string' ? data.arguments : '', 300),
          result: null,
        }
        entries.push(entry)
        if (typeof data.callId === 'string') pendingCalls.set(`${data.turn}:${data.callId}`, entry)
        continue
      }
      if (event.type === 'tool/result') {
        const callId = data.toolCallId ?? data.message?.toolCallId ?? data.message?.source?.callId
        const entry = typeof callId === 'string' ? pendingCalls.get(`${data.turn}:${callId}`) : undefined
        const text = textBlocks(data.message?.content)
        if (entry !== undefined) entry.result = previewText(text, 400)
        else entries.push({ seq: event.seq, at: event.time, role: 'tool', name: null, arguments: '', result: previewText(text, 400) })
      }
    }
    return entries
  }

  /** Read the recent transcript of one session without waking it. */
  async function readTranscript(exec, sessionId, limit, includeTools) {
    let inspection
    try {
      inspection = await ctx.sessionController.inspect(sessionId, exec.signal)
    } catch (error) {
      throw new Error(`cannot inspect session "${sessionId}": ${describeAgentError(error)}`)
    }
    const all = transcriptEntries(inspection?.events)
    const filtered = includeTools ? all : all.filter((entry) => entry.role !== 'tool')
    const page = filtered.slice(-limit)
    return { total: filtered.length, entries: page }
  }

  /** Register all mesh tools in one effect. */
  ctx.effect(() => {
    const disposers = []

    disposers.push(ctx.tools.register({
      name: 'mesh_list_sessions',
      description:
        'List sessions across all workspaces with title, workspace, working directory, running and archived state. Use it to discover peers before messaging, or to audit the mesh. Prefer the cursor for stable paging on a changing list.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: {
            type: 'string',
            description: 'Only sessions in this workspace: exact workspace id, exact directory path, or a case-insensitive title/path substring.',
          },
          running: { type: 'boolean', description: 'true returns only sessions with a turn currently running; false returns only idle sessions.' },
          include_archived: { type: 'boolean', description: 'Include archived sessions. Defaults to false.' },
          include_subagents: { type: 'boolean', description: 'Include subagent child sessions. Defaults to false.' },
          query: { type: 'string', description: 'Case-insensitive substring match on session id or title. Matching titles requires reading titles for all candidates, so prefer id or workspace filters when possible.' },
          limit: { type: 'integer', description: 'Maximum rows to return, 1 through 200. Defaults to 50.' },
          cursor: { type: 'string', description: 'Opaque nextCursor from a previous call. When present, offset is ignored.' },
          offset: { type: 'integer', description: 'Zero-based result offset. Defaults to 0. Ignored when cursor is present.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const limit = args.limit ?? 50
        const offset = args.offset ?? 0
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 through 200')
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative safe integer')
        const { rows, workspaces } = await readRows(exec)
        let filtered = rows
        if (args.include_subagents !== true) filtered = filtered.filter((row) => !row.subagent)
        if (args.include_archived !== true) filtered = filtered.filter((row) => !row.archived)
        if (typeof args.running === 'boolean') filtered = filtered.filter((row) => row.running === args.running)
        let workspaceId = null
        if (typeof args.workspace === 'string' && args.workspace.trim().length > 0) {
          const workspace = resolveWorkspace(workspaces, args.workspace)
          if (workspace === undefined) throw new Error(`workspace "${args.workspace}" not found`)
          workspaceId = workspace.id
          filtered = filtered.filter((row) => row.workspaceId === workspaceId)
        }
        let queryTitles
        const needle = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
        if (needle.length > 0) {
          queryTitles = await fetchTitles(filtered.map((row) => row.sessionId), exec.signal)
          for (const row of filtered) row.title = queryTitles.get(row.sessionId) ?? null
          filtered = filtered.filter((row) =>
            row.sessionId.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle),
          )
        }
        filtered.sort(compareRows)
        if (typeof args.cursor === 'string' && args.cursor.length > 0) {
          const cursor = decodeCursor(args.cursor)
          filtered = filtered.filter((row) => compareRows(row, cursor) > 0)
        } else if (offset > 0) {
          filtered = filtered.slice(offset)
        }
        const page = filtered.slice(0, limit)
        if (queryTitles === undefined) {
          const titles = await fetchTitles(page.map((row) => row.sessionId), exec.signal)
          for (const row of page) row.title = titles.get(row.sessionId) ?? null
        }
        const nextCursor = filtered.length > page.length && page.length > 0
          ? encodeCursor(page[page.length - 1])
          : undefined
        return JSON.stringify({
          total: filtered.length,
          returned: page.length,
          ...nextCursor === undefined ? {} : { nextCursor },
          sessions: page,
        })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_send_message',
      description:
        'Send one self-contained message to any session in any workspace. The message is delivered as a real agent message carrying your session id as its sender. A running target receives it after its current turn (queue) or at its nearest step boundary (steer, when enabled); an idle target wakes and starts a turn; a cold target is resumed. Success means acceptance into the target inbox, not completion. Messages are rate-limited and identical repeats within a minute are suppressed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'message'],
        properties: {
          target: { type: 'string', description: 'Exact target session id from mesh_list_sessions. Never your own session id.' },
          message: { type: 'string', description: 'Complete message for the target session. The target cannot see your conversation, so include all needed context.' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue delivers after the target current turn (default); steer delivers at its nearest step boundary and may be disabled by the deployment.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const agent = callerAgent(exec, 'mesh_send_message')
        const target = requiredString(args.target, 'target', 200)
        const body = requiredString(args.message, 'message', 200000)
        if (target === agent.id) throw new Error('mesh_send_message cannot target the calling session itself')
        const mode = args.mode ?? settings.defaultMode
        if (mode !== 'queue' && mode !== 'steer') throw new Error('mode must be queue or steer')
        if (mode === 'steer' && !settings.allowSteer) {
          throw new Error('steer delivery is disabled by the session-mesh configuration; use mode "queue"')
        }
        checkPeerAllowlist(target)
        const { rows } = await readRows(exec)
        const targetRow = findRow(rows, target)
        if (targetRow === undefined) {
          throw new Error(`session "${target}" not found among visible sessions; call mesh_list_sessions with include_archived true if needed`)
        }
        if (targetRow.archived && !settings.allowArchivedSend) {
          throw new Error(`session "${target}" is archived; unarchive it with mesh_archive_session before messaging`)
        }
        // Titles are not part of the lightweight row scan: resolve the two
        // identities actually used by this send (cached or read once).
        const missingTitleIds = [agent.id, target].filter((id) => cachedTitle(id) === undefined)
        if (missingTitleIds.length > 0) await fetchTitles(missingTitleIds, exec.signal)
        const senderRow = findRow(rows, agent.id)
        const senderTitle = senderRow?.title ?? cachedTitle(agent.id) ?? '(untitled)'
        const text = peerMessageText({ ...(senderRow ?? {}), title: senderTitle }, agent.id, body)
        const bytes = Buffer.byteLength(text, 'utf8')
        if (bytes > settings.maxMessageBytes) {
          throw new Error(`message exceeds ${settings.maxMessageBytes} bytes after the mesh envelope; shorten it`)
        }
        checkSendPolicy(agent.id, target, text)
        const targetTitle = targetRow.title ?? cachedTitle(target) ?? null
        const messageId = await deliverToAgent(exec, agent, target, text, mode)
        ctx.logger?.info?.(`session-mesh: ${agent.id} -> ${target} (${bytes}B, ${mode}, ${messageId})`)
        return JSON.stringify({
          sent: true,
          target,
          targetTitle,
          targetWorkspace: targetRow.workspaceTitle,
          mode,
          targetWasRunning: targetRow.running,
          messageId,
          senderSource: 'agent-message/relay',
          note: 'Accepted into the target inbox as an agent message. This does not confirm that the target processed the message.',
        })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_create_session',
      description:
        'Create a new root session, optionally in a named workspace, with a title and an initial prompt. Use it to start a parallel task in a fresh conversation that participates in the same mesh.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'Initial task for the new session. Omit it to create an empty session.' },
          title: { type: 'string', description: 'Title to give the new session immediately after creation.' },
          workspace: { type: 'string', description: 'Workspace id, directory path, or title match. Defaults to the calling session workspace, then its working directory.' },
          agent_preset: { type: 'string', description: 'Optional agent preset id for the new session.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowCreate) throw new Error('mesh_create_session is disabled by the session-mesh configuration')
        const agent = callerAgent(exec, 'mesh_create_session')
        const request = {}
        let workspaceId = null
        if (typeof args.workspace === 'string' && args.workspace.trim().length > 0) {
          const workspace = resolveWorkspace(ctx.workspaceRegistry.list(), args.workspace)
          if (workspace === undefined) throw new Error(`workspace "${args.workspace}" not found`)
          request.workspaceId = workspace.id
          workspaceId = workspace.id
        } else {
          const index = buildWorkspaceIndex()
          const home = workspaceForSession(index, agent.id, agent.session?.header?.cwd)
          if (home !== undefined) {
            request.workspaceId = home.id
            workspaceId = home.id
          } else {
            const cwd = agent.session?.header?.cwd
            if (typeof cwd === 'string' && cwd.length > 0) request.cwd = cwd
          }
        }
        if (typeof args.agent_preset === 'string' && args.agent_preset.trim().length > 0) {
          request.agentPreset = args.agent_preset.trim()
        }
        const created = await ctx.sessionController.create(request)
        const sessionId = created?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session creation returned no session id')
        const warnings = []
        let title = null
        if (typeof args.title === 'string' && args.title.trim().length > 0) {
          try {
            const renamed = await ctx.sessionController.rename({ sessionId, title: args.title.trim() })
            title = renamed?.title ?? args.title.trim()
            titleCache.delete(sessionId)
          } catch (error) {
            warnings.push(`title was not applied: ${describeAgentError(error)}`)
          }
        }
        let promptQueued = false
        if (typeof args.prompt === 'string' && args.prompt.trim().length > 0) {
          await ctx.sessionController.prompt({
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: args.prompt }],
          }, exec.signal)
          promptQueued = true
        }
        return JSON.stringify({
          created: true,
          sessionId,
          title,
          workspaceId,
          promptQueued,
          ...warnings.length > 0 ? { warnings } : {},
          note: promptQueued ? 'The new session started with the given prompt.' : 'The new session is empty until prompted.',
        })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_rename_session',
      description: 'Rename any session in any workspace. The new title is pinned as an explicit user title.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'title'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          title: { type: 'string', description: 'Replacement title.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        callerAgent(exec, 'mesh_rename_session')
        const target = requiredString(args.target, 'target', 200)
        const title = requiredString(args.title, 'title', 500)
        try {
          const renamed = await ctx.sessionController.rename({ sessionId: target, title })
          titleCache.delete(target)
          return JSON.stringify({ renamed: true, sessionId: target, title: renamed?.title ?? title })
        } catch (error) {
          throw new Error(`cannot rename session "${target}": ${describeAgentError(error)}`)
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_archive_session',
      description:
        'Archive or unarchive any session in any workspace. Archiving a session with running work fails unless stop_activity is true, which stops that work first. Archived sessions are hidden from default listing and cannot be woken until restored.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          action: { type: 'string', enum: ['archive', 'unarchive'], description: 'archive (default) or unarchive.' },
          stop_activity: { type: 'boolean', description: 'For archive: stop running work instead of refusing. Defaults to false.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowArchive) throw new Error('mesh_archive_session is disabled by the session-mesh configuration')
        callerAgent(exec, 'mesh_archive_session')
        const target = requiredString(args.target, 'target', 200)
        const action = args.action ?? 'archive'
        try {
          if (action === 'archive') {
            await ctx.workspaceRegistry.archiveSession(target, { stopActivity: args.stop_activity === true })
            return JSON.stringify({ archived: true, sessionId: target, stoppedActivity: args.stop_activity === true })
          }
          if (action === 'unarchive') {
            await ctx.workspaceRegistry.unarchiveSession(target)
            return JSON.stringify({ archived: false, sessionId: target })
          }
        } catch (error) {
          const activity = Array.isArray(error?.activity) ? error.activity : undefined
          if (activity !== undefined && activity.length > 0) {
            const families = activity
              .map((entry) => `${String(entry?.kind ?? 'activity')} × ${Array.isArray(entry?.items) ? entry.items.length : '?'}`)
              .join(', ')
            throw new Error(`session "${target}" still has running work (${families}); pass stop_activity: true to stop it and archive`)
          }
          throw new Error(`cannot ${action} session "${target}": ${describeAgentError(error)}`)
        }
        throw new Error('action must be archive or unarchive')
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_cancel_session',
      description:
        "Stop one session's currently running turn without clearing its pending inbox. Use it to stop a peer that is looping or working on a stale task.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions. Not your own session.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowCancel) throw new Error('mesh_cancel_session is disabled by the session-mesh configuration')
        const agent = callerAgent(exec, 'mesh_cancel_session')
        const target = requiredString(args.target, 'target', 200)
        if (target === agent.id) throw new Error('mesh_cancel_session cannot target the calling session itself')
        try {
          const result = await ctx.sessionController.cancel({ sessionId: target })
          return JSON.stringify({ cancelled: true, sessionId: target, accepted: result?.accepted === true })
        } catch (error) {
          throw new Error(`cannot cancel session "${target}": ${describeAgentError(error)}`)
        }
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_get_goal',
      description:
        "Read the current long-term goal of any session. The goal lives in the target session's own log; a cold session is read from its persisted log without waking it. Returns { goal: null } when the session has no current goal.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        callerAgent(exec, 'mesh_get_goal')
        const target = requiredString(args.target, 'target', 200)
        const state = await readGoalState(exec, target)
        return JSON.stringify({ sessionId: target, goal: state.goal, live: state.live })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_set_goal',
      description:
        "Create or edit another session's long-term goal. Creates a new goal when the session has none or its goal is complete (objective required); otherwise edits objective and/or round cap in place without changing phase. Always read with mesh_get_goal first and pass the observed expected_revision. Writing to a cold session resumes it.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          objective: { type: 'string', description: 'Long-term completion objective. Required when creating; optional when editing.' },
          max_goal_rounds: { type: 'integer', description: 'Positive round budget for automatic continuation. Optional.' },
          expected_revision: { type: 'integer', description: 'Observed goal revision from mesh_get_goal; a stale value is rejected.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowGoal) throw new Error('goal management is disabled by the session-mesh configuration')
        callerAgent(exec, 'mesh_set_goal')
        const target = requiredString(args.target, 'target', 200)
        const hasObjective = typeof args.objective === 'string' && args.objective.trim().length > 0
        const hasRounds = args.max_goal_rounds !== undefined
        if (!hasObjective && !hasRounds) throw new Error('mesh_set_goal requires objective and/or max_goal_rounds')
        if (hasRounds) goalRounds(args.max_goal_rounds)
        const goals = goalServiceOrThrow()
        const targetAgent = await resolveTargetAgent(exec, target)
        const current = goalView(goals.get(targetAgent))
        if (current === null || current.phase === 'complete') {
          if (!hasObjective) throw new Error('creating a goal requires objective')
          const created = goals.create(targetAgent, {
            objective: args.objective.trim(),
            ...hasRounds ? { maxGoalRounds: args.max_goal_rounds } : {},
          })
          return JSON.stringify({ action: 'created', sessionId: target, goal: goalView(created) })
        }
        const ref = requireGoalRef(current, args.expected_revision, target)
        const edited = goals.edit(targetAgent, ref, {
          ...hasObjective ? { objective: args.objective.trim() } : {},
          ...hasRounds ? { maxGoalRounds: args.max_goal_rounds } : {},
        })
        return JSON.stringify({ action: 'edited', sessionId: target, goal: goalView(edited) })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_update_goal',
      description:
        "Change the lifecycle phase of another session's long-term goal: pause, resume or complete it. Always read with mesh_get_goal first and pass the observed expected_revision. Resume works while the round budget still has capacity; a paused goal can also be resumed this way.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'action'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'complete'],
            description: 'pause stops automatic continuation, resume re-arms it, complete marks the goal finished.',
          },
          expected_revision: { type: 'integer', description: 'Observed goal revision from mesh_get_goal; a stale value is rejected.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowGoal) throw new Error('goal management is disabled by the session-mesh configuration')
        callerAgent(exec, 'mesh_update_goal')
        const target = requiredString(args.target, 'target', 200)
        const action = args.action
        if (action !== 'pause' && action !== 'resume' && action !== 'complete') {
          throw new Error('action must be pause, resume or complete')
        }
        const goals = goalServiceOrThrow()
        const targetAgent = await resolveTargetAgent(exec, target)
        const current = goalView(goals.get(targetAgent))
        const ref = requireGoalRef(current, args.expected_revision, target)
        let updated
        try {
          updated = action === 'pause'
            ? goals.pause(targetAgent, ref)
            : action === 'resume' ? goals.resume(targetAgent, ref) : goals.complete(targetAgent, ref)
        } catch (error) {
          throw new Error(`cannot ${action} the goal of session "${target}": ${describeAgentError(error)}`)
        }
        return JSON.stringify({ action, sessionId: target, goal: goalView(updated) })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_clear_goal',
      description:
        "Remove another session's current long-term goal. The goal history stays in the target session log. Always read with mesh_get_goal first and pass the observed expected_revision; a stale value is rejected.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          expected_revision: { type: 'integer', description: 'Observed goal revision from mesh_get_goal; a stale value is rejected.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowGoal) throw new Error('goal management is disabled by the session-mesh configuration')
        callerAgent(exec, 'mesh_clear_goal')
        const target = requiredString(args.target, 'target', 200)
        const goals = goalServiceOrThrow()
        const targetAgent = await resolveTargetAgent(exec, target)
        const current = goalView(goals.get(targetAgent))
        const ref = requireGoalRef(current, args.expected_revision, target)
        let cleared
        try {
          cleared = goals.clear(targetAgent, ref)
        } catch (error) {
          throw new Error(`cannot clear the goal of session "${target}": ${describeAgentError(error)}`)
        }
        return JSON.stringify({
          cleared: true,
          sessionId: target,
          goalId: cleared?.id ?? ref.id,
          revision: cleared?.revision ?? ref.revision,
        })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_start_goal',
      description:
        "Start another session's long-term goal: creates a goal when the session has none or its goal is complete (objective required), resumes a paused/blocked goal, and is a no-op for an already-active armed goal. Read with mesh_get_goal first and pass expected_revision when the goal exists.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          objective: { type: 'string', description: 'Objective for a newly created goal. Required when no goal exists.' },
          max_goal_rounds: { type: 'integer', description: 'Positive round budget for a newly created goal.' },
          expected_revision: { type: 'integer', description: 'Observed goal revision from mesh_get_goal; a stale value is rejected.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowGoal) throw new Error('goal management is disabled by the session-mesh configuration')
        callerAgent(exec, 'mesh_start_goal')
        const target = requiredString(args.target, 'target', 200)
        const hasObjective = typeof args.objective === 'string' && args.objective.trim().length > 0
        const hasRounds = args.max_goal_rounds !== undefined
        if (hasRounds) goalRounds(args.max_goal_rounds)
        const goals = goalServiceOrThrow()
        const targetAgent = await resolveTargetAgent(exec, target)
        const current = goalView(goals.get(targetAgent))
        if (current === null || current.phase === 'complete') {
          if (!hasObjective) throw new Error('starting a new goal requires objective')
          const created = goals.create(targetAgent, {
            objective: args.objective.trim(),
            ...hasRounds ? { maxGoalRounds: args.max_goal_rounds } : {},
          })
          return JSON.stringify({ action: 'created', sessionId: target, goal: goalView(created) })
        }
        const ref = requireGoalRef(current, args.expected_revision, target)
        if (current.phase === 'active' && current.activation !== 'disarmed') {
          return JSON.stringify({ action: 'already-active', sessionId: target, goal: current })
        }
        let resumed
        try {
          resumed = goals.resume(targetAgent, ref)
        } catch (error) {
          throw new Error(`cannot start the goal of session "${target}": ${describeAgentError(error)}`)
        }
        return JSON.stringify({ action: 'resumed', sessionId: target, goal: goalView(resumed) })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_stop_goal',
      description:
        "Stop another session's long-term goal by pausing it (automatic continuation stops; state and revision are kept). No-op when the goal is already paused, blocked or complete. Read with mesh_get_goal first and pass expected_revision.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          expected_revision: { type: 'integer', description: 'Observed goal revision from mesh_get_goal; a stale value is rejected.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        if (!settings.allowGoal) throw new Error('goal management is disabled by the session-mesh configuration')
        callerAgent(exec, 'mesh_stop_goal')
        const target = requiredString(args.target, 'target', 200)
        const goals = goalServiceOrThrow()
        const targetAgent = await resolveTargetAgent(exec, target)
        const current = goalView(goals.get(targetAgent))
        const ref = requireGoalRef(current, args.expected_revision, target)
        if (current.phase !== 'active') {
          return JSON.stringify({ action: 'already-stopped', sessionId: target, goal: current })
        }
        let paused
        try {
          paused = goals.pause(targetAgent, ref)
        } catch (error) {
          throw new Error(`cannot stop the goal of session "${target}": ${describeAgentError(error)}`)
        }
        return JSON.stringify({ action: 'paused', sessionId: target, goal: goalView(paused) })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_read_session',
      description:
        'Read the most recent conversation entries of any session to understand quickly what it is working on: human messages, peer (agent) messages, assistant replies, and tool calls with their results. The target log is read without waking the session. Entries are chronological and text-previewed; use a small limit.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Exact session id from mesh_list_sessions.' },
          limit: { type: 'integer', description: 'Number of most recent entries to return, 1 through 50. Defaults to 20.' },
          include_tools: { type: 'boolean', description: 'Include tool calls/results. Defaults to true.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        callerAgent(exec, 'mesh_read_session')
        const target = requiredString(args.target, 'target', 200)
        const limit = args.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new Error('limit must be an integer from 1 through 50')
        }
        const transcript = await readTranscript(exec, target, limit, args.include_tools !== false)
        const { rows } = await readRows(exec)
        const row = findRow(rows, target)
        let title = row?.title ?? cachedTitle(target) ?? null
        if (title === null) {
          const titles = await fetchTitles([target], exec.signal)
          title = titles.get(target) ?? null
        }
        return JSON.stringify({
          sessionId: target,
          title,
          workspaceTitle: row?.workspaceTitle ?? null,
          running: row?.running === true,
          archived: row?.archived === true,
          total: transcript.total,
          returned: transcript.entries.length,
          entries: transcript.entries,
        })
      },
    }))

    disposers.push(ctx.tools.register({
      name: 'mesh_wait_for_change',
      description:
        'Wait for the next session activity, status change, creation or removal after this call starts, instead of polling mesh_list_sessions. Returns the first observed change or a timeout. Re-list after wakeup or timeout.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeout_ms: { type: 'integer', description: 'Wait duration in milliseconds, from 1000 through 3600000. Defaults to 30000.' },
          include_self: { type: 'boolean', description: 'Also report changes to the calling session. Defaults to false.' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const agent = callerAgent(exec, 'mesh_wait_for_change')
        const timeoutMs = args.timeout_ms ?? 30000
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
          throw new Error('timeout_ms must be an integer from 1000 through 3600000')
        }
        const includeSelf = args.include_self === true
        const signal = exec.signal
        const change = await new Promise((resolve, reject) => {
          let settled = false
          const stops = []
          const cleanup = () => {
            clearTimeout(timer)
            for (const stop of stops) {
              try {
                stop()
              } catch {
                /* listener already gone */
              }
            }
            signal?.removeEventListener('abort', onAbort)
          }
          const finish = (value) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(value)
          }
          const onAbort = () => {
            if (settled) return
            settled = true
            cleanup()
            reject(new Error('mesh_wait_for_change aborted'))
          }
          const relevant = (sessionId) => includeSelf || sessionId !== agent.id
          const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
          stops.push(ctx.on('api-session/status', (sessionId, running) => {
            if (relevant(sessionId)) finish({ timedOut: false, change: { type: 'status', sessionId, running } })
          }))
          stops.push(ctx.on('api-session/activity', (sessionId, updatedAt) => {
            if (relevant(sessionId)) finish({ timedOut: false, change: { type: 'activity', sessionId, updatedAt } })
          }))
          stops.push(ctx.on('api-session/added', (summary) => {
            const sessionId = summary?.sessionId
            if (typeof sessionId === 'string' && relevant(sessionId)) finish({ timedOut: false, change: { type: 'added', sessionId } })
          }))
          stops.push(ctx.on('api-session/removed', (sessionId) => {
            if (relevant(sessionId)) finish({ timedOut: false, change: { type: 'removed', sessionId } })
          }))
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
        })
        return JSON.stringify(change)
      },
    }))

    return () => {
      while (disposers.length > 0) {
        const disposer = disposers.pop()
        try {
          disposer?.()
        } catch {
          /* registration teardown must not mask earlier failures */
        }
      }
    }
  }, 'session-mesh.tools()')

  // System-prompt policy: shared guidance for every root session.
  if (settings.policy !== 'off') {
    const text = settings.policy === 'full' ? POLICY_FULL : POLICY_SHORT
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'session-mesh:policy', order: 610, text }),
      'session-mesh.policy()',
    )
  }

  if (settings.identityContext) {
    const installed = new Map()

    const identityFor = (agent) => {
      // Prompt assembly must never fail because mesh identity is unavailable.
      const fallback = `You are session "${agent.id}".\nUse the mesh_* tools to coordinate with other sessions; peer messages start with "[mesh]".`
      try {
        const header = agent.session?.header ?? {}
        const index = buildWorkspaceIndex()
        const title = liveTitle(ctx.sessionTitle, agent.session)
        const workspace = workspaceForSession(index, agent.id, header.cwd)
        const where = workspace !== undefined
          ? ` in workspace "${workspace.title}" (${workspace.path})`
          : typeof header.cwd === 'string' && header.cwd.length > 0 ? ` at "${header.cwd}"` : ''
        return `You are session "${title ?? '(untitled)'}" (${agent.id})${where}.\nUse the mesh_* tools to coordinate with other sessions; peer messages start with "[mesh]".`
      } catch (error) {
        ctx.logger?.warn?.(`session-mesh: identity text failed: ${String(error?.message ?? error)}`)
        return fallback
      }
    }

    const install = (agent) => {
      if (installed.has(agent)) return
      // Subagent child sessions are not mesh peers; skip them.
      if (agent.session?.header?.parentSession !== undefined) return
      try {
        const scoped = agent.ctx
        const disposer = scoped.systemPrompt.context({
          name: 'session-mesh:identity',
          order: 126,
          required: true,
          text: () => identityFor(agent),
        })
        installed.set(agent, disposer)
      } catch (error) {
        ctx.logger?.warn?.(`session-mesh: identity context install failed: ${String(error?.message ?? error)}`)
      }
    }

    for (const agent of ctx.agents.list()) install(agent)
    ctx.effect(() => {
      const stopCreated = ctx.on('agent/created', ({ agent }) => install(agent))
      const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
        try {
          installed.get(agent)?.()
        } catch {
          /* already unwound */
        }
        installed.delete(agent)
      })
      return () => {
        stopCreated()
        stopDisposed()
        for (const disposer of installed.values()) {
          try {
            disposer()
          } catch {
            /* already unwound */
          }
        }
        installed.clear()
      }
    }, 'session-mesh.identity()')
  }
}
