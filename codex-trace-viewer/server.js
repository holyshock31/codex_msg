import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.CODEX_TRACE_VIEWER_HOST || "127.0.0.1";
const PORT = Number(process.env.CODEX_TRACE_VIEWER_PORT || "45123");
const INGEST_HOST = process.env.CODEX_TRACE_INGEST_HOST || "127.0.0.1";
const INGEST_PORT = Number(process.env.CODEX_TRACE_INGEST_PORT || "45124");
const TRACE_FILE =
  process.env.CODEX_TRACE_FILE ||
  path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex-trace", "events.ndjson");
const CODEX_HOME =
  process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");
const SESSION_INDEX_FILE = process.env.CODEX_TRACE_SESSION_INDEX_FILE || path.join(CODEX_HOME, "session_index.jsonl");
const MAX_EVENTS = Number(process.env.CODEX_TRACE_VIEWER_MAX_EVENTS || "5000");
const INITIAL_TAIL_BYTES = Number(process.env.CODEX_TRACE_VIEWER_TAIL_BYTES || String(8 * 1024 * 1024));
const PRELOAD_NDJSON = (process.env.CODEX_TRACE_PRELOAD_NDJSON || "false").toLowerCase() === "true";
const COMPACT_DELTA_CHARS = Number(process.env.CODEX_TRACE_COMPACT_DELTA_CHARS || "8192");
const COMPACT_TEXT_CHARS = Number(process.env.CODEX_TRACE_COMPACT_TEXT_CHARS || "16000");
const COMPACT_RAW_CHARS = Number(process.env.CODEX_TRACE_COMPACT_RAW_CHARS || "2000");
const MAX_CONVERSATION_SESSIONS = Number(process.env.CODEX_TRACE_CONVERSATION_MAX_SESSIONS || "200");
const MAX_SEGMENT_CONTENT_CHARS = Number(process.env.CODEX_TRACE_SEGMENT_MAX_CHARS || String(1024 * 1024));
const RAW_SAMPLE_HEAD_EVENTS = Number(process.env.CODEX_TRACE_SEGMENT_RAW_HEAD_EVENTS || "3");
const RAW_SAMPLE_TAIL_EVENTS = Number(process.env.CODEX_TRACE_SEGMENT_RAW_TAIL_EVENTS || "5");

const publicDir = path.join(__dirname, "public");
const clients = new Set();
const ring = [];
const threadMetadata = new Map();
const conversationSessions = new Map();
let lastOffset = 0;
let lastSeq = 0;
let readBuffer = "";
let fileMissing = false;
let totalParsed = 0;
let totalParseErrors = 0;
let totalIngested = 0;
let conversationVersion = 0;
let ingestClients = 0;
let sessionIndexLoaded = false;
let sessionIndexLastMtimeMs = 0;
let sessionIndexRecords = 0;
let watcher = null;
let readInProgress = false;

function pushEvent(event) {
  updateThreadMetadataFromEvent(event);
  updateConversationStore(event);
  ring.push(event);
  if (ring.length > MAX_EVENTS) ring.shift();
  totalParsed += 1;
  if (event.parseError || event.rawParseError) totalParseErrors += 1;
  lastSeq = Math.max(lastSeq, Number(event.seq) || 0);
  broadcast("event", event);
}

function pushOuterEvent(outer) {
  const event = normalizeOuter(outer);
  if (event) {
    totalIngested += 1;
    pushEvent(event);
  }
}

function broadcast(type, payload) {
  for (const client of clients) {
    const outbound = type === "event" && client.compact ? compactEvent(payload) : payload;
    const encoded = `event: ${type}\ndata: ${JSON.stringify(outbound)}\n\n`;
    client.res.write(encoded);
  }
}

function normalizeLine(line) {
  if (!line.trim()) return null;
  let outer;
  try {
    outer = JSON.parse(line);
  } catch (error) {
    return {
      seq: null,
      ts_ms: Date.now(),
      dir: "parse_error",
      raw: line,
      parseError: error.message,
      method: null,
      sessionId: null,
      threadId: null,
      turnId: null,
      itemId: null,
      itemType: null,
      summary: line.slice(0, 200),
    };
  }
  return normalizeOuter(outer);
}

function normalizeOuter(outer) {
  let rawJson = null;
  let rawParseError = null;
  if (typeof outer.raw === "string" && outer.raw.trim()) {
    try {
      rawJson = JSON.parse(outer.raw);
    } catch (error) {
      rawParseError = error.message;
    }
  }

  const params = rawJson?.params;
  const item = params?.item;
  const thread = params?.thread || rawJson?.result?.thread || null;
  const method = rawJson?.method || null;
  const requestId = rawJson?.id == null ? null : String(rawJson.id);
  const threadId = params?.threadId || params?.thread_id || item?.threadId || thread?.id || thread?.threadId || thread?.thread_id || null;
  const sessionId = params?.sessionId || params?.session_id || thread?.sessionId || thread?.session_id || null;
  const turnId = params?.turnId || params?.turn_id || item?.turnId || null;
  const itemId = params?.itemId || params?.item_id || item?.id || null;
  const itemType = item?.type || null;

  return {
    schema: outer.schema || null,
    seq: outer.seq ?? null,
    ts_ms: outer.ts_ms ?? null,
    pid: outer.pid ?? null,
    dir: outer.dir || "unknown",
    source: outer.source || "local",
    sourceId: outer.source_id || outer.sourceId || "",
    transport: outer.transport || "",
    connectionId: outer.connection_id || outer.connectionId || "",
    codec: outer.codec || "",
    method,
    requestId,
    sessionId,
    threadId,
    turnId,
    itemId,
    itemType,
    raw: outer.raw ?? "",
    rawJson,
    rawParseError,
    summary: summarize({ outer, rawJson, rawParseError }),
  };
}

function summarize({ outer, rawJson, rawParseError }) {
  if (!rawJson) {
    return rawParseError ? `raw parse error: ${rawParseError}` : String(outer.raw || "").slice(0, 200);
  }
  const method = rawJson.method;
  const params = rawJson.params;
  const item = params?.item;
  if (method === "item/agentMessage/delta") return `delta: ${params?.delta ?? ""}`;
  if (method === "item/commandExecution/outputDelta") return `output: ${params?.delta ?? ""}`;
  if (method === "item/reasoning/summaryTextDelta") return `reasoning summary: ${params?.delta ?? ""}`;
  if (method === "item/reasoning/textDelta") return `reasoning text: ${params?.delta ?? ""}`;
  if (method === "item/reasoning/summaryPartAdded") return `reasoning summary part added: ${params?.itemId ?? ""}`;
  if (method === "item/started" && item) return `${item.type || "item"} started ${item.id || ""}`;
  if (method === "item/completed" && item) {
    if (item.type === "agentMessage") return `agent message completed: ${(item.text || "").slice(0, 160)}`;
    return `${item.type || "item"} completed ${item.id || ""}`;
  }
  if (method) return method;
  if (rawJson.id != null) return `response id=${rawJson.id}`;
  return JSON.stringify(rawJson).slice(0, 200);
}

function updateConversationStore(event) {
  const threadId = event.threadId || event.rawJson?.params?.threadId || event.rawJson?.params?.thread_id;
  if (!threadId) return;
  const metadata = getThreadMetadata(threadId);
  const sessionId = resolveConversationSessionId(threadId, metadata, event.sessionId || threadId);
  moveConversationThreadToSession(threadId, sessionId);

  const session = getConversationSession(sessionId);
  const thread = getConversationThread(session, threadId);
  thread.displaySessionId = session.id;
  applyConversationThreadMetadata(thread, metadata, event.sessionId);
  applyConversationSessionMetadata(session, thread);
  session.events += 1;
  thread.events += 1;
  session.lastTs = Math.max(session.lastTs || 0, event.ts_ms || 0);
  thread.lastTs = Math.max(thread.lastTs || 0, event.ts_ms || 0);
  session.source = mergeSourceLabel(session.source, event.source);
  thread.source = mergeSourceLabel(thread.source, event.source);

  const extracted = extractConversationEvent(event);
  if (!extracted) {
    conversationVersion += 1;
    trimConversationSessions();
    return;
  }

  const turnId = extracted.turnId || event.turnId || "unknown-turn";
  const turn = getConversationTurn(thread, turnId);
  applyConversationTurnMeta(turn, event);
  if (extracted.block) {
    applyConversationBlock(turn, extracted.block, event);
    if (!thread.preview && extracted.block.preview) thread.preview = extracted.block.preview;
    if (!session.preview && extracted.block.preview) session.preview = extracted.block.preview;
  }
  conversationVersion += 1;
  trimConversationSessions();
}

function resolveConversationSessionId(threadId, metadata, fallbackSessionId, seen = new Set()) {
  if (!threadId || seen.has(threadId)) return fallbackSessionId || threadId;
  seen.add(threadId);
  const parentThreadId = metadata?.parentThreadId;
  if (!parentThreadId) return metadata?.sessionId || fallbackSessionId || threadId;

  const existingParentSessionId = findConversationSessionIdForThread(parentThreadId);
  if (existingParentSessionId) return existingParentSessionId;

  const parentMetadata = getThreadMetadata(parentThreadId);
  if (parentMetadata) {
    return resolveConversationSessionId(parentThreadId, parentMetadata, parentMetadata.sessionId || parentThreadId, seen);
  }

  return parentThreadId;
}

function findConversationSessionIdForThread(threadId) {
  for (const session of conversationSessions.values()) {
    if (session.threadsById?.has(threadId)) return session.id;
  }
  return "";
}

function moveConversationThreadToSession(threadId, sessionId) {
  if (!threadId || !sessionId) return;
  const currentSessionId = findConversationSessionIdForThread(threadId);
  if (!currentSessionId || currentSessionId === sessionId) return;
  const currentSession = conversationSessions.get(currentSessionId);
  const thread = currentSession?.threadsById?.get(threadId);
  if (!currentSession || !thread) return;

  currentSession.threadsById.delete(threadId);
  currentSession.threads = currentSession.threads.filter((candidate) => candidate.id !== threadId);
  recalculateConversationSession(currentSession);
  if (!currentSession.threads.length) {
    conversationSessions.delete(currentSession.id);
  }

  const targetSession = getConversationSession(sessionId);
  if (targetSession.threadsById.has(threadId)) return;
  thread.displaySessionId = sessionId;
  targetSession.threadsById.set(threadId, thread);
  targetSession.threads.push(thread);
  recalculateConversationSession(targetSession);
  applyConversationSessionMetadata(targetSession, thread);
}

function recalculateConversationSession(session) {
  session.events = session.threads.reduce((sum, candidate) => sum + candidate.events, 0);
  session.blocks = session.threads.reduce((sum, candidate) => sum + candidate.blocks, 0);
  session.turnCount = session.threads.reduce((sum, candidate) => sum + candidate.turns.length, 0);
  session.threadCount = session.threads.length;
  session.lastTs = session.threads.reduce((max, candidate) => Math.max(max, candidate.lastTs || 0), 0);
  session.source = session.threads.reduce((label, candidate) => mergeSourceLabel(label, candidate.source), "");
}

function getConversationSession(id) {
  if (!conversationSessions.has(id)) {
    conversationSessions.set(id, {
      id,
      title: "",
      cwd: "",
      preview: "",
      threadsById: new Map(),
      threads: [],
      events: 0,
      blocks: 0,
      turnCount: 0,
      threadCount: 0,
      lastTs: 0,
      source: "",
    });
  }
  return conversationSessions.get(id);
}

function getConversationThread(session, id) {
  if (!session.threadsById.has(id)) {
    const thread = {
      id,
      sessionId: session.id,
      displaySessionId: session.id,
      title: "",
      cwd: "",
      threadPreview: "",
      turnsById: new Map(),
      turns: [],
      events: 0,
      blocks: 0,
      preview: "",
      lastTs: 0,
      source: "",
      parentThreadId: "",
      forkedFromId: "",
      agentNickname: "",
      agentRole: "",
    };
    session.threadsById.set(id, thread);
    session.threads.push(thread);
  }
  return session.threadsById.get(id);
}

function applyConversationThreadMetadata(thread, metadata, rawSessionId = "") {
  if (!metadata) return;
  if (metadata.title) thread.title = metadata.title;
  if (metadata.preview) thread.threadPreview = metadata.preview;
  if (metadata.cwd) thread.cwd = metadata.cwd;
  if (metadata.sessionId || rawSessionId) thread.sessionId = metadata.sessionId || rawSessionId;
  if (metadata.parentThreadId) thread.parentThreadId = metadata.parentThreadId;
  if (metadata.forkedFromId) thread.forkedFromId = metadata.forkedFromId;
  if (metadata.agentNickname) thread.agentNickname = metadata.agentNickname;
  if (metadata.agentRole) thread.agentRole = metadata.agentRole;
}

function applyConversationSessionMetadata(session, thread) {
  if (!thread) return;
  const rootLike = thread.id === session.id || !thread.parentThreadId;
  if (rootLike || !session.title) {
    if (thread.title) session.title = thread.title;
    if (thread.cwd) session.cwd = thread.cwd;
  }
  if (!session.preview && (thread.threadPreview || thread.preview)) {
    session.preview = thread.threadPreview || thread.preview;
  }
}

function mergeSourceLabel(current, next) {
  const value = next || "local";
  if (!current) return value;
  if (current === value) return current;
  return "mixed";
}

function getConversationTurn(session, id) {
  if (!session.turnsById.has(id)) {
    const turn = { id, blocksByKey: new Map(), blocks: [], firstTs: 0, status: "", durationMs: null };
    session.turnsById.set(id, turn);
    session.turns.push(turn);
  }
  return session.turnsById.get(id);
}

function applyConversationTurnMeta(turn, event) {
  const raw = event.rawJson;
  const params = raw?.params;
  const method = raw?.method;
  const ts = event.ts_ms || 0;
  turn.firstTs = turn.firstTs ? Math.min(turn.firstTs, ts) : ts;
  if ((method === "turn/started" || method === "turn/completed") && params?.turn) {
    turn.status = params.turn.status || turn.status;
    turn.durationMs = params.turn.durationMs ?? turn.durationMs;
  }
}

function extractConversationEvent(event) {
  const raw = event.rawJson;
  const method = raw?.method;
  const params = raw?.params || {};
  const item = params.item;
  if (method === "turn/start") {
    return null;
  }
  if (method === "turn/plan/updated") {
    return {
      turnId: params.turnId,
      block: {
        key: `plan:${params.turnId}`,
        kind: "plan",
        role: "plan",
        label: "plan",
        meta: "turn/plan/updated",
        plan: params.plan || [],
        preview: "plan update",
      },
    };
  }
  if (method === "turn/diff/updated") {
    return {
      turnId: params.turnId,
      block: {
        key: `diff:${params.turnId}`,
        kind: "diff",
        role: "file",
        label: "diff",
        meta: "turn/diff/updated",
        diff: params.diff || "",
        preview: "diff updated",
      },
    };
  }
  if (method === "item/agentMessage/delta") {
    return {
      turnId: params.turnId,
      block: {
        key: params.itemId || `assistant-delta:${event.seq}`,
        itemId: params.itemId,
        kind: "assistant",
        role: "assistant",
        label: "assistant",
        meta: "streaming",
        text: params.delta || "",
        appendText: true,
        preview: params.delta || "assistant delta",
      },
    };
  }
  if (method === "item/commandExecution/outputDelta") {
    return {
      turnId: params.turnId,
      block: {
        key: params.itemId || `command-delta:${event.seq}`,
        itemId: params.itemId,
        kind: "command",
        role: "tool",
        label: "command",
        meta: "output",
        output: params.delta || "",
        appendOutput: true,
        preview: "command output",
      },
    };
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    return {
      turnId: params.turnId,
      block: {
        key: params.itemId || `reasoning-delta:${event.seq}`,
        itemId: params.itemId,
        itemType: "reasoning",
        kind: "thinking",
        role: "thinking",
        label: method === "item/reasoning/summaryTextDelta" ? "think / summary" : "think / raw",
        meta: method,
        text: params.delta || "",
        appendText: true,
        preview: params.delta || "thinking delta",
      },
    };
  }
  if (method === "item/reasoning/summaryPartAdded") {
    return {
      turnId: params.turnId,
      block: {
        key: params.itemId || `reasoning-summary:${event.seq}`,
        itemId: params.itemId,
        itemType: "reasoning",
        kind: "thinking",
        role: "thinking",
        label: "think / summary",
        meta: method,
        text: params.summaryIndex > 0 ? "\n\n" : "",
        appendText: params.summaryIndex > 0,
        preview: "thinking summary part",
      },
    };
  }
  if (!item) return null;

  const turnId = params.turnId;
  const base = {
    key: item.id || `${item.type}:${event.seq}`,
    itemId: item.id,
    itemType: item.type,
    status: item.status,
    preview: item.type,
  };

  if (item.type === "userMessage") {
    const text = contentToText(item.content);
    const preview = userFacingUserText(text);
    return {
      turnId,
      block: {
        ...base,
        kind: "user",
        role: "user",
        label: "user",
        meta: "userMessage",
        text,
        preview: preview.slice(0, 140),
      },
    };
  }
  if (item.type === "agentMessage") {
    return {
      turnId,
      block: {
        ...base,
        kind: "assistant",
        role: "assistant",
        label: item.phase === "commentary" ? "assistant / commentary" : "assistant",
        meta: item.phase || "agentMessage",
        text: item.text || "",
        preview: (item.text || "assistant").slice(0, 140),
      },
    };
  }
  if (item.type === "reasoning") {
    return {
      turnId,
      block: {
        ...base,
        kind: "thinking",
        role: "thinking",
        label: "think",
        meta: "reasoning",
        text: reasoningText(item),
        preview: "thinking",
      },
    };
  }
  if (item.type === "commandExecution") {
    return {
      turnId,
      block: {
        ...base,
        kind: "command",
        role: "tool",
        label: "command",
        meta: item.status || "commandExecution",
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        output: item.aggregatedOutput || "",
        preview: item.command || "command",
      },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      turnId,
      block: {
        ...base,
        kind: "tool",
        role: "tool",
        label: "mcp tool",
        meta: item.status || "mcpToolCall",
        server: item.server,
        tool: item.tool,
        argumentsText: stringifyCompact(item.arguments),
        resultText: stringifyCompact(item.result),
        error: item.error,
        preview: `${item.server || "mcp"}.${item.tool || "tool"}`,
      },
    };
  }
  if (item.type === "fileChange") {
    return {
      turnId,
      block: {
        ...base,
        kind: "file",
        role: "file",
        label: "file change",
        meta: item.status || "fileChange",
        changes: item.changes || [],
        preview: `${(item.changes || []).length} file changes`,
      },
    };
  }
  if (item.type === "imageGeneration") {
    return {
      turnId,
      block: {
        ...base,
        kind: "image",
        role: "tool",
        label: "image",
        meta: item.status || "imageGeneration",
        revisedPrompt: item.revisedPrompt,
        savedPath: item.savedPath,
        preview: "image generation",
      },
    };
  }
  if (item.type === "contextCompaction") {
    return {
      turnId,
      block: {
        ...base,
        kind: "system",
        role: "system",
        label: "compaction",
        meta: "contextCompaction",
        text: item.id || "context compaction",
        preview: "context compaction",
      },
    };
  }
  return {
    turnId,
    block: {
      ...base,
      kind: "system",
      role: "system",
      label: item.type || "item",
      meta: method || "",
      text: stringifyCompact(item),
      preview: item.type || "item",
    },
  };
}

function applyConversationBlock(turn, update, event) {
  const key = update.key || `${update.kind}:${event.seq ?? event.ts_ms ?? turn.blocks.length}`;
  let block = turn.blocksByKey.get(key);
  if (!block) {
    block = {
      ...update,
      key,
      events: [],
      eventCount: 0,
      omittedEventCount: 0,
      firstSeq: event.seq ?? null,
      lastSeq: event.seq ?? null,
      firstTs: event.ts_ms || 0,
      lastTs: event.ts_ms || 0,
      text: "",
      output: "",
      contentTruncated: false,
    };
    turn.blocksByKey.set(key, block);
    turn.blocks.push(block);
  }
  addRawEventSample(block, event);
  block.eventCount += 1;
  block.lastSeq = event.seq ?? block.lastSeq;
  block.lastTs = event.ts_ms || block.lastTs;
  block.meta = update.meta || block.meta;
  block.status = update.status ?? block.status;
  block.exitCode = update.exitCode ?? block.exitCode;
  block.durationMs = update.durationMs ?? block.durationMs;
  for (const field of ["label", "role", "kind", "command", "cwd", "server", "tool", "argumentsText", "resultText", "error", "changes", "plan", "diff", "revisedPrompt", "savedPath"]) {
    if (update[field] != null && update[field] !== "") block[field] = update[field];
  }
  if (update.appendText) {
    block.text = boundedSegmentValue(block, `${block.text || ""}${update.text || ""}`);
  } else if (update.text != null && update.text !== "") {
    block.text = boundedSegmentValue(block, update.text);
  }
  if (update.appendOutput) {
    block.output = boundedSegmentValue(block, `${block.output || ""}${update.output || ""}`);
  } else if (update.output != null && update.output !== "") {
    block.output = boundedSegmentValue(block, update.output);
  }
  if (update.preview) block.preview = update.preview;
}

function boundedSegmentValue(block, value) {
  const text = String(value || "");
  if (text.length <= MAX_SEGMENT_CONTENT_CHARS) return text;
  block.contentTruncated = true;
  const head = Math.floor(MAX_SEGMENT_CONTENT_CHARS * 0.72);
  const tail = MAX_SEGMENT_CONTENT_CHARS - head;
  return `${text.slice(0, head)}\n\n... ${text.length - MAX_SEGMENT_CONTENT_CHARS} chars omitted while aggregating segment ...\n\n${text.slice(-tail)}`;
}

function addRawEventSample(block, event) {
  const sample = compactEvent(event);
  if (block.events.length < RAW_SAMPLE_HEAD_EVENTS + RAW_SAMPLE_TAIL_EVENTS) {
    block.events.push(sample);
    return;
  }
  block.omittedEventCount += 1;
  const tailStart = RAW_SAMPLE_HEAD_EVENTS;
  block.events.splice(tailStart, 1);
  block.events.push(sample);
}

function contentToText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.text) return part.text;
      return stringifyCompact(part);
    })
    .filter(Boolean)
    .join("\n");
}

function userFacingUserText(value) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const requestMarker = "## My request for Codex:";
  const markerIndex = text.lastIndexOf(requestMarker);
  if (markerIndex >= 0) {
    return text.slice(markerIndex + requestMarker.length).trim();
  }

  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (line.startsWith("# Files mentioned by the user:") || line.startsWith("# In app browser:")) {
      index += 1;
      while (index < lines.length) {
        const next = lines[index].trim();
        if (next.startsWith("## My request")) break;
        if (next.startsWith("# ") && !next.startsWith("# Files mentioned by the user:") && !next.startsWith("# In app browser:")) break;
        index += 1;
      }
      continue;
    }
    break;
  }
  return lines.slice(index).join("\n").trim() || text;
}

function reasoningText(item) {
  const summary = Array.isArray(item.summary) ? item.summary.map((part) => part.text || part).join("\n") : "";
  const content = Array.isArray(item.content) ? item.content.map((part) => part.text || part).join("\n") : "";
  return [summary, content].filter(Boolean).join("\n\n");
}

function stringifyCompact(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function trimConversationSessions() {
  if (conversationSessions.size <= MAX_CONVERSATION_SESSIONS) return;
  const sorted = [...conversationSessions.values()].sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));
  for (const session of sorted.slice(0, conversationSessions.size - MAX_CONVERSATION_SESSIONS)) {
    conversationSessions.delete(session.id);
  }
}

function conversationModel() {
  const sessions = [...conversationSessions.values()].map(serializeConversationSession);
  sessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return { version: conversationVersion, sessions };
}

function serializeConversationSession(session) {
  const threads = session.threads.map(serializeConversationThread).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const blocks = threads.reduce((sum, thread) => sum + thread.blocks, 0);
  const turnCount = threads.reduce((sum, thread) => sum + thread.turns.length, 0);
  session.blocks = blocks;
  session.turnCount = turnCount;
  session.threadCount = threads.length;
  return {
    id: session.id,
    sessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    preview: session.preview,
    events: session.events,
    blocks,
    turnCount,
    threadCount: threads.length,
    lastTs: session.lastTs,
    source: session.source || "local",
    threads,
  };
}

function serializeConversationThread(thread) {
  applyConversationThreadMetadata(thread, getThreadMetadata(thread.id));
  const turns = thread.turns.map(serializeConversationTurn).sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
  const blocks = turns.reduce((sum, turn) => sum + turn.blocks.length, 0);
  thread.blocks = blocks;
  return {
    id: thread.id,
    threadId: thread.id,
    sessionId: thread.sessionId,
    displaySessionId: thread.displaySessionId,
    title: thread.title,
    cwd: thread.cwd,
    threadPreview: thread.threadPreview,
    preview: thread.preview,
    events: thread.events,
    blocks,
    lastTs: thread.lastTs,
    source: thread.source || "local",
    parentThreadId: thread.parentThreadId,
    forkedFromId: thread.forkedFromId,
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
    turns,
  };
}

function serializeConversationTurn(turn) {
  const blocks = turn.blocks.map(serializeConversationBlock).sort((a, b) => (a.firstSeq || 0) - (b.firstSeq || 0));
  return {
    id: turn.id,
    firstTs: turn.firstTs,
    status: turn.status,
    durationMs: turn.durationMs,
    blocks,
  };
}

function serializeConversationBlock(block) {
  const { blocksByKey, ...rest } = block;
  return {
    ...rest,
    events: block.events || [],
    rawSample: {
      sampledEvents: block.events?.length || 0,
      omittedEventCount: block.omittedEventCount || 0,
      headEvents: RAW_SAMPLE_HEAD_EVENTS,
      tailEvents: RAW_SAMPLE_TAIL_EVENTS,
    },
  };
}

function compactEvent(event) {
  const metadata = getThreadMetadata(event.threadId);
  return {
    seq: event.seq ?? null,
    ts_ms: event.ts_ms ?? null,
    pid: event.pid ?? null,
    dir: event.dir || "unknown",
    source: event.source || "local",
    sourceId: event.sourceId || "",
    transport: event.transport || "",
    connectionId: event.connectionId || "",
    codec: event.codec || "",
    method: event.method || null,
    requestId: event.requestId || null,
    sessionId: event.sessionId || metadata?.sessionId || null,
    threadId: event.threadId || null,
    turnId: event.turnId || null,
    itemId: event.itemId || null,
    itemType: event.itemType || null,
    threadName: metadata?.title || "",
    threadPreview: metadata?.preview || "",
    threadCwd: metadata?.cwd || "",
    parseError: event.parseError || null,
    rawParseError: event.rawParseError || null,
    raw: truncateText(event.raw || "", COMPACT_RAW_CHARS),
    rawJson: compactRawJson(event.rawJson),
    summary: truncateText(event.summary || "", 1000),
  };
}

function compactRawJson(rawJson) {
  if (!rawJson || typeof rawJson !== "object") return rawJson ?? null;
  const out = {};
  if (rawJson.jsonrpc != null) out.jsonrpc = rawJson.jsonrpc;
  if (rawJson.id != null) out.id = rawJson.id;
  if (rawJson.method != null) out.method = rawJson.method;
  if (rawJson.params != null) out.params = compactParams(rawJson.params);
  if (rawJson.result != null) out.result = compactResult(rawJson.result);
  if (rawJson.error != null) out.error = compactValue(rawJson.error);
  return out;
}

function compactParams(params) {
  if (!params || typeof params !== "object") return params ?? null;
  const out = {};
  for (const key of [
    "sessionId",
    "session_id",
    "threadId",
    "thread_id",
    "parentThreadId",
    "parent_thread_id",
    "turnId",
    "turn_id",
    "itemId",
    "item_id",
    "clientUserMessageId",
  ]) {
    if (params[key] != null) out[key] = params[key];
  }
  if (params.delta != null) out.delta = truncateText(params.delta, COMPACT_DELTA_CHARS);
  if (params.input != null) out.input = compactValue(params.input);
  if (params.plan != null) out.plan = compactValue(params.plan);
  if (params.diff != null) out.diff = truncateText(params.diff, COMPACT_TEXT_CHARS);
  if (params.turn != null) out.turn = compactValue(params.turn);
  if (params.item != null) out.item = compactItem(params.item);
  return out;
}

function compactItem(item) {
  if (!item || typeof item !== "object") return item ?? null;
  const out = {};
  for (const key of [
    "id",
    "type",
    "status",
    "phase",
    "command",
    "cwd",
    "exitCode",
    "durationMs",
    "server",
    "tool",
    "error",
    "savedPath",
    "revisedPrompt",
  ]) {
    if (item[key] != null) out[key] = item[key];
  }
  for (const key of ["content", "summary", "arguments", "result", "changes", "plan"]) {
    if (item[key] != null) out[key] = compactValue(item[key]);
  }
  if (item.text != null) out.text = truncateText(item.text, COMPACT_TEXT_CHARS);
  if (item.diff != null) out.diff = truncateText(item.diff, COMPACT_TEXT_CHARS);
  if (item.aggregatedOutput != null) out.aggregatedOutput = truncateText(item.aggregatedOutput, COMPACT_TEXT_CHARS);
  return out;
}

function compactResult(result) {
  if (!result || typeof result !== "object") return compactValue(result);
  if (result.thread && typeof result.thread === "object") {
    return { thread: compactThreadRecord(result.thread) || compactValue(result.thread) };
  }
  if (Array.isArray(result.data)) {
    const threadRows = result.data.map(compactThreadRecord).filter(Boolean);
    if (threadRows.length) {
      return {
        data: threadRows,
        nextCursor: result.nextCursor ?? result.next_cursor ?? null,
      };
    }
    return {
      dataCount: result.data.length,
      nextCursor: result.nextCursor ?? result.next_cursor ?? null,
    };
  }
  const keys = Object.keys(result);
  return { keys: keys.slice(0, 20) };
}

function compactThreadRecord(item) {
  if (!item || typeof item !== "object") return null;
  const id = stringValue(item.id || item.threadId || item.thread_id);
  const sessionId = stringValue(item.sessionId || item.session_id);
  const title = stringValue(item.name || item.title || item.thread_name);
  const preview = stringValue(item.preview);
  const cwd = stringValue(item.cwd || item.path);
  if (!id || (!title && !preview && !cwd && !sessionId)) return null;
  return {
    id,
    sessionId,
    parentThreadId: stringValue(item.parentThreadId || item.parent_thread_id),
    forkedFromId: stringValue(item.forkedFromId || item.forked_from_id),
    agentNickname: stringValue(item.agentNickname || item.agent_nickname),
    agentRole: stringValue(item.agentRole || item.agent_role),
    name: title,
    title,
    preview,
    cwd,
    path: stringValue(item.path),
    updatedAt: item.updatedAt ?? item.updated_at ?? item.recencyAt ?? item.recency_at ?? null,
    updated_at: item.updated_at ?? item.updatedAt ?? item.recency_at ?? item.recencyAt ?? null,
    recencyAt: item.recencyAt ?? item.recency_at ?? null,
    createdAt: item.createdAt ?? item.created_at ?? null,
    created_at: item.created_at ?? item.createdAt ?? null,
  };
}

function compactValue(value, maxStringChars = COMPACT_TEXT_CHARS) {
  if (value == null) return value;
  if (typeof value === "string") return truncateText(value, maxStringChars);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => compactValue(item, maxStringChars));
  const out = {};
  for (const key of Object.keys(value).slice(0, 80)) {
    out[key] = compactValue(value[key], maxStringChars);
  }
  return out;
}

function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.72);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n... ${text.length - maxChars} chars omitted ...\n\n${text.slice(-tail)}`;
}

function updateThreadMetadataFromEvent(event) {
  const rawJson = event.rawJson;
  const data = rawJson?.result?.data;
  if (Array.isArray(data)) {
    for (const item of data) mergeThreadMetadata(compactThreadRecord(item), "trace");
  }
  mergeThreadMetadata(compactThreadRecord(rawJson?.result?.thread), "trace");
  mergeThreadMetadata(compactThreadRecord(rawJson?.params?.thread), "trace");
}

function mergeThreadMetadata(record, source) {
  if (!record?.id) return;
  const updatedAt = numericTimestamp(record.updatedAt ?? record.updated_at ?? record.recencyAt ?? record.createdAt ?? record.created_at);
  const current = threadMetadata.get(record.id) || {
    id: record.id,
    title: "",
    preview: "",
    cwd: "",
    sessionId: "",
    parentThreadId: "",
    forkedFromId: "",
    agentNickname: "",
    agentRole: "",
    updatedAt: 0,
    source: "",
  };
  const newer = updatedAt >= current.updatedAt;
  threadMetadata.set(record.id, {
    id: record.id,
    title: record.name && (newer || !current.title) ? record.name : current.title,
    preview: record.preview && (newer || !current.preview) ? record.preview : current.preview,
    cwd: record.cwd && (newer || !current.cwd) ? record.cwd : current.cwd,
    sessionId: record.sessionId || current.sessionId || record.id,
    parentThreadId: record.parentThreadId || current.parentThreadId || "",
    forkedFromId: record.forkedFromId || current.forkedFromId || "",
    agentNickname: record.agentNickname || current.agentNickname || "",
    agentRole: record.agentRole || current.agentRole || "",
    updatedAt: Math.max(current.updatedAt, updatedAt),
    source: source || current.source,
  });
}

function getThreadMetadata(threadId) {
  if (!threadId) return null;
  return threadMetadata.get(threadId) || null;
}

async function refreshSessionIndexMetadata() {
  try {
    const stat = await fsp.stat(SESSION_INDEX_FILE);
    if (stat.mtimeMs === sessionIndexLastMtimeMs) return;
    const text = await fsp.readFile(SESSION_INDEX_FILE, "utf8");
    let records = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        mergeThreadMetadata(
          compactThreadRecord({
            id: row.id,
            sessionId: row.sessionId || row.session_id,
            name: row.thread_name || row.name || row.title,
            preview: row.preview,
            cwd: row.cwd || row.path,
            updatedAt: row.updated_at || row.updatedAt,
            createdAt: row.created_at || row.createdAt,
          }),
          "session_index",
        );
        records += 1;
      } catch {
        // Ignore malformed historical rows; the live trace remains authoritative.
      }
    }
    sessionIndexLoaded = true;
    sessionIndexLastMtimeMs = stat.mtimeMs;
    sessionIndexRecords = records;
  } catch (error) {
    if (error.code === "ENOENT") {
      sessionIndexLoaded = false;
      sessionIndexRecords = 0;
      return;
    }
    console.warn(`Failed to read session index: ${error.message}`);
  }
}

function stringValue(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.includes("\uFFFD") ? "" : text;
}

function numericTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function initializeTail() {
  if (!PRELOAD_NDJSON) {
    fileMissing = true;
    return;
  }
  try {
    const stat = await fsp.stat(TRACE_FILE);
    fileMissing = false;
    const start = Math.max(0, stat.size - INITIAL_TAIL_BYTES);
    lastOffset = start;
    await readFromOffset(start, { discardPartialFirstLine: start > 0 });
    lastOffset = stat.size;
  } catch (error) {
    if (error.code === "ENOENT") {
      fileMissing = true;
      lastOffset = 0;
      return;
    }
    throw error;
  }
}

async function readFromOffset(offset, options = {}) {
  const handle = await fsp.open(TRACE_FILE, "r");
  try {
    const stat = await handle.stat();
    if (offset > stat.size) {
      offset = 0;
      readBuffer = "";
    }
    let position = offset;
    const chunk = Buffer.alloc(64 * 1024);
    while (position < stat.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      let text = chunk.subarray(0, bytesRead).toString("utf8");
      if (options.discardPartialFirstLine) {
        const newlineIndex = text.search(/\r?\n/);
        if (newlineIndex < 0) continue;
        text = text.slice(newlineIndex + (text[newlineIndex] === "\r" && text[newlineIndex + 1] === "\n" ? 2 : 1));
        options.discardPartialFirstLine = false;
      }
      consumeText(text);
    }
    lastOffset = position;
  } finally {
    await handle.close();
  }
}

function consumeText(text) {
  readBuffer += text;
  const lines = readBuffer.split(/\r?\n/);
  readBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const event = normalizeLine(line);
    if (event) pushEvent(event);
  }
}

async function pollNewData() {
  if (readInProgress) return;
  readInProgress = true;
  try {
    const stat = await fsp.stat(TRACE_FILE);
    fileMissing = false;
    if (stat.size < lastOffset) {
      lastOffset = 0;
      readBuffer = "";
    }
    if (stat.size > lastOffset) {
      await readFromOffset(lastOffset);
    }
    broadcast("status", currentStatus());
  } catch (error) {
    if (error.code === "ENOENT") {
      fileMissing = true;
      broadcast("status", currentStatus());
    } else {
      broadcast("status", { ...currentStatus(), error: error.message });
    }
  } finally {
    readInProgress = false;
  }
}

function startWatching() {
  if (!PRELOAD_NDJSON) return;
  const dir = path.dirname(TRACE_FILE);
  try {
    watcher = fs.watch(dir, { persistent: true }, (_eventType, filename) => {
      if (!filename || filename.toString().toLowerCase() === path.basename(TRACE_FILE).toLowerCase()) {
        pollNewData();
      }
    });
  } catch {
    watcher = null;
  }
  setInterval(pollNewData, 1000).unref();
}

function startIngestServer() {
  const server = net.createServer((socket) => {
    ingestClients += 1;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          pushOuterEvent(JSON.parse(line));
        } catch (error) {
          pushEvent({
            seq: null,
            ts_ms: Date.now(),
            dir: "parse_error",
            raw: line,
            parseError: error.message,
            method: null,
            sessionId: null,
            threadId: null,
            turnId: null,
            itemId: null,
            itemType: null,
            summary: line.slice(0, 200),
          });
        }
      }
      broadcast("status", currentStatus());
    });
    socket.on("close", () => {
      ingestClients = Math.max(0, ingestClients - 1);
      broadcast("status", currentStatus());
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });
  server.listen(INGEST_PORT, INGEST_HOST, () => {
    console.log(`Codex trace ingest listening on tcp://${INGEST_HOST}:${INGEST_PORT}`);
  });
  return server;
}

function currentStatus() {
  return {
    traceFile: TRACE_FILE,
    fileMissing,
    lastOffset,
    lastSeq,
    bufferedEvents: ring.length,
    totalParsed,
    totalParseErrors,
    clients: clients.size,
    ingestClients,
    totalIngested,
    conversationVersion,
    conversationSessions: conversationSessions.size,
    maxEvents: MAX_EVENTS,
    maxConversationSessions: MAX_CONVERSATION_SESSIONS,
    ingest: `tcp://${INGEST_HOST}:${INGEST_PORT}`,
    preloadNdjson: PRELOAD_NDJSON,
    sessionIndexFile: SESSION_INDEX_FILE,
    sessionIndexLoaded,
    sessionIndexRecords,
    threadMetadataCount: threadMetadata.size,
  };
}

function threadMetadataList() {
  return [...threadMetadata.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function sendJson(res, value, statusCode = 200) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname === "/api/status") {
    sendJson(res, currentStatus());
    return;
  }
  if (url.pathname === "/api/events") {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || "1000"), MAX_EVENTS));
    const events = ring.slice(-limit);
    sendJson(res, url.searchParams.get("compact") === "1" ? events.map(compactEvent) : events);
    return;
  }
  if (url.pathname === "/api/conversations") {
    sendJson(res, conversationModel());
    return;
  }
  if (url.pathname === "/api/thread-metadata") {
    sendJson(res, threadMetadataList());
    return;
  }
  if (url.pathname === "/events") {
    const client = {
      res,
      compact: url.searchParams.get("compact") === "1",
    };
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: status\ndata: ${JSON.stringify(currentStatus())}\n\n`);
    clients.add(client);
    req.on("close", () => clients.delete(client));
    return;
  }
  await serveStatic(req, res);
});

await refreshSessionIndexMetadata();
setInterval(refreshSessionIndexMetadata, 5000).unref();
await initializeTail();
startWatching();
const ingestServer = startIngestServer();
server.listen(PORT, HOST, () => {
  console.log(`Codex trace viewer listening on http://${HOST}:${PORT}`);
  console.log(`Trace file: ${TRACE_FILE}`);
});

process.on("SIGINT", () => {
  watcher?.close();
  ingestServer.close();
  server.close(() => process.exit(0));
});
