import {
  buildAggregateRailGroups,
  buildAggregateGroups,
  resolveContinuousSegment,
} from "./conversation-segments.js";

const state = {
  events: [],
  nextViewId: 1,
  selectedViewId: null,
  selectedSessionId: "",
  expandedSessionId: "",
  selectedThreadId: "",
  selectedTurnId: "",
  selectedSegmentKey: "",
  selectedAggregateKey: "",
  activeTab: "conversation",
  paused: false,
  status: null,
  storage: null,
  storageRefreshScheduled: false,
  tokenUsage: null,
  tokenUsageRefreshScheduled: false,
  conversationModel: null,
  conversationRefreshScheduled: false,
  conversationRefreshTimer: null,
  conversationRefreshInFlight: false,
  conversationRefreshDirty: false,
  conversationViewSignature: "",
  conversationFollowLatest: true,
  conversationUnreadUpdates: 0,
  conversationScrollApplying: false,
  renderScheduled: false,
  turnSortDescending: true,
};

const maxDisplayedBlockChars = 16000;
const maxStoredBlockChars = 32000;
const maxTimelineSummaryChars = 600;
const longItemGapMs = 30_000;
const conversationRefreshVisibleMs = 1000;
const conversationRefreshHiddenMs = 5000;
const conversationFollowEdgePx = 80;
const temporarySessionId = "__codex_trace_temporary_sessions__";
const debugPerf = new URLSearchParams(window.location.search).get("debugPerf") === "1";
const jumpFlashTimers = new WeakMap();
const threadDetailRequests = new Map();
const conversationNodeSignatures = new WeakMap();
const conversationNodeContexts = new WeakMap();
const exactEventDetailsCache = new Map();
let conversationResizeObserver = null;
let conversationObservedAnchor = null;
let conversationScrollApplyToken = 0;
let segmentRawSelection = null;
let segmentRawEventIndex = 0;
let segmentRawActiveTab = "original";
let segmentRawLoadToken = 0;
let segmentContentMode = "original";
let segmentContentModeKey = "";
const conversationPerf = {
  modelRequests: 0,
  modelActive: 0,
  modelMaxActive: 0,
  unchangedResponses: 0,
  threadRequests: 0,
  lastEndpoint: "",
  lastBytes: 0,
  lastDurationMs: 0,
};
function publishConversationPerf() {
  if (!debugPerf) return;
  window.__traceViewerPerf = conversationPerf;
  document.documentElement.dataset.tracePerf = JSON.stringify(conversationPerf);
}
publishConversationPerf();
const temporarySessionTitle = "临时会话";

const els = {
  statusLine: document.querySelector("#statusLine"),
  conversationTabBtn: document.querySelector("#conversationTabBtn"),
  tokensTabBtn: document.querySelector("#tokensTabBtn"),
  timelineTabBtn: document.querySelector("#timelineTabBtn"),
  pauseBtn: document.querySelector("#pauseBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  dirFilter: document.querySelector("#dirFilter"),
  methodFilter: document.querySelector("#methodFilter"),
  threadFilter: document.querySelector("#threadFilter"),
  textFilter: document.querySelector("#textFilter"),
  limitInput: document.querySelector("#limitInput"),
  conversationView: document.querySelector("#conversationView"),
  conversationSplitter: document.querySelector("#conversationSplitter"),
  tokensView: document.querySelector("#tokensView"),
  tokensMeta: document.querySelector("#tokensMeta"),
  refreshTokensBtn: document.querySelector("#refreshTokensBtn"),
  tokenTotalValue: document.querySelector("#tokenTotalValue"),
  tokenInputValue: document.querySelector("#tokenInputValue"),
  tokenCachedValue: document.querySelector("#tokenCachedValue"),
  tokenOutputValue: document.querySelector("#tokenOutputValue"),
  tokenReasoningValue: document.querySelector("#tokenReasoningValue"),
  tokenContextValue: document.querySelector("#tokenContextValue"),
  tokenThreadsTable: document.querySelector("#tokenThreadsTable"),
  tokenTurnsTable: document.querySelector("#tokenTurnsTable"),
  timelineView: document.querySelector("#timelineView"),
  sessionList: document.querySelector("#sessionList"),
  sessionCountLine: document.querySelector("#sessionCountLine"),
  storageSummary: document.querySelector("#storageSummary"),
  storageDetail: document.querySelector("#storageDetail"),
  refreshStorageBtn: document.querySelector("#refreshStorageBtn"),
  storageKeepDaysInput: document.querySelector("#storageKeepDaysInput"),
  storageTargetMbInput: document.querySelector("#storageTargetMbInput"),
  cleanupStorageBtn: document.querySelector("#cleanupStorageBtn"),
  turnOverlay: document.querySelector("#turnOverlay"),
  turnOverlayTitle: document.querySelector("#turnOverlayTitle"),
  turnOverlayMeta: document.querySelector("#turnOverlayMeta"),
  turnOverlayList: document.querySelector("#turnOverlayList"),
  turnSortBtn: document.querySelector("#turnSortBtn"),
  closeTurnOverlayBtn: document.querySelector("#closeTurnOverlayBtn"),
  conversationTitle: document.querySelector("#conversationTitle"),
  conversationMeta: document.querySelector("#conversationMeta"),
  conversationMessages: document.querySelector("#conversationMessages"),
  segmentRail: document.querySelector("#segmentRail"),
  aggregateRail: document.querySelector("#aggregateRail"),
  aggregateLinks: document.querySelector("#aggregateLinks"),
  followLatestBtn: document.querySelector("#followLatestBtn"),
  chatShell: document.querySelector(".chatShell"),
  detailSplitter: document.querySelector("#detailSplitter"),
  segmentDetail: document.querySelector("#segmentDetail"),
  segmentDetailTitle: document.querySelector("#segmentDetailTitle"),
  segmentDetailMeta: document.querySelector("#segmentDetailMeta"),
  segmentContentPre: document.querySelector("#segmentContentPre"),
  segmentEncodingControls: document.querySelector("#segmentEncodingControls"),
  segmentEncodingBadge: document.querySelector("#segmentEncodingBadge"),
  segmentRecoveredBtn: document.querySelector("#segmentRecoveredBtn"),
  segmentOriginalBtn: document.querySelector("#segmentOriginalBtn"),
  openSegmentRawBtn: document.querySelector("#openSegmentRawBtn"),
  segmentRawModal: document.querySelector("#segmentRawModal"),
  segmentRawBackdrop: document.querySelector("#segmentRawBackdrop"),
  segmentRawMeta: document.querySelector("#segmentRawMeta"),
  segmentEventSummary: document.querySelector("#segmentEventSummary"),
  segmentEventList: document.querySelector("#segmentEventList"),
  segmentOriginalTab: document.querySelector("#segmentOriginalTab"),
  segmentProcessedTab: document.querySelector("#segmentProcessedTab"),
  segmentOriginalPanel: document.querySelector("#segmentOriginalPanel"),
  segmentProcessedPanel: document.querySelector("#segmentProcessedPanel"),
  segmentOriginalStatus: document.querySelector("#segmentOriginalStatus"),
  segmentOriginalPre: document.querySelector("#segmentOriginalPre"),
  segmentProcessedContent: document.querySelector("#segmentProcessedContent"),
  closeSegmentRawBtn: document.querySelector("#closeSegmentRawBtn"),
  closeSegmentDetailBtn: document.querySelector("#closeSegmentDetailBtn"),
  eventList: document.querySelector("#eventList"),
  detailPanel: document.querySelector("#detailPanel"),
  detailPre: document.querySelector("#detailPre"),
  closeDetailBtn: document.querySelector("#closeDetailBtn"),
  detailBackdrop: document.querySelector("#detailBackdrop"),
  countLine: document.querySelector("#countLine"),
  liveLine: document.querySelector("#liveLine"),
};

function eventTime(event) {
  if (!event.ts_ms) return "";
  const date = new Date(event.ts_ms);
  return date.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(date.getMilliseconds()).padStart(3, "0");
}

function clockTime(ms) {
  return eventTime({ ts_ms: ms });
}

function durationLabel(ms) {
  if (ms == null) return "";
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 10_000) return `${trimDecimal(value / 1000)}s`;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h${minutes ? `${minutes}m` : ""}${seconds ? `${seconds}s` : ""}`;
  return `${minutes}m${seconds ? `${seconds}s` : ""}`;
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function compactGapLabel(ms) {
  if (ms == null) return "";
  const value = Math.max(0, Number(ms) || 0);
  if (value < 10_000) return `+${trimDecimal(value / 1000)}s`;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `+${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `+${hours}h${minutes ? `${minutes}m` : ""}`;
  return `+${minutes}m${seconds ? `${seconds}s` : ""}`;
}

function blockStartMs(block) {
  return Number(block?.firstTs || block?.events?.[0]?.ts_ms || 0);
}

function blockEndMs(block) {
  const events = block?.events || [];
  return Number(block?.lastTs || events[events.length - 1]?.ts_ms || blockStartMs(block) || 0);
}

function turnStartMs(turn) {
  return turnLifecycleTimeMs(turn, "start");
}

function turnEndMs(turn) {
  return turnLifecycleTimeMs(turn, "end");
}

function turnDurationMs(turn) {
  if (turn?.durationMs != null) {
    const recorded = Number(turn.durationMs);
    if (Number.isFinite(recorded) && recorded >= 0) return recorded;
  }
  const start = turnStartMs(turn);
  const end = turnEndMs(turn) || Math.max(0, ...(turn?.blocks || []).map(blockEndMs));
  if (!start || !end || end < start) return null;
  return end - start;
}

function blockTimingMap(turn) {
  const timing = new Map();
  let previousStart = turnStartMs(turn);
  for (const block of turn?.blocks || []) {
    const startMs = blockStartMs(block);
    const gapMs = startMs && previousStart ? Math.max(0, startMs - previousStart) : null;
    timing.set(block, { startMs, gapMs });
    if (startMs) previousStart = startMs;
  }
  return timing;
}

function methodLabel(event) {
  return event.method || (event.requestId ? `response:${event.requestId}` : "(no method)");
}

function sourceLabel(value) {
  return value || "local";
}

function shortId(value) {
  if (!value) return "";
  return value.length > 12 ? value.slice(0, 8) + "..." : value;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${units[index]}`;
}

function formatTokenCount(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 10_000) return `${(number / 1000).toFixed(1)}K`;
  return String(Math.round(number));
}

function formatPercent(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0%";
  return `${(number * 100).toFixed(number >= 0.1 ? 1 : 2)}%`;
}

function formatTokenLine(label, totals = {}) {
  return `${label}: total ${formatTokenCount(totals.totalTokens)}, input ${formatTokenCount(totals.inputTokens)}, cached ${formatTokenCount(totals.cachedInputTokens)}, output ${formatTokenCount(totals.outputTokens)}, reasoning ${formatTokenCount(totals.reasoningOutputTokens)}`;
}

function tokenUsageTitle(turn) {
  const usage = turn?.tokenUsage;
  if (!usage) return "";
  const lines = ["Tokens"];
  lines.push(formatTokenLine("last call", usage.last));
  lines.push(formatTokenLine("thread total", usage.total));
  if (usage.last?.inputTokens) {
    lines.push(`cache hit: ${formatPercent(usage.last.cachedInputTokens / usage.last.inputTokens)} of last input`);
  }
  if (usage.modelContextWindow) {
    lines.push(`context: ${formatPercent((usage.last?.totalTokens || 0) / usage.modelContextWindow)} of ${formatTokenCount(usage.modelContextWindow)}`);
  }
  return lines.join("\n");
}

function formatDateTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function passesFilters(event) {
  const dir = els.dirFilter.value;
  const method = els.methodFilter.value.trim().toLowerCase();
  const thread = els.threadFilter.value.trim().toLowerCase();
  const text = els.textFilter.value.trim().toLowerCase();
  if (dir && event.dir !== dir) return false;
  if (method && !eventMethodSearchText(event).includes(method)) return false;
  if (thread && !eventMatchesThreadFilter(event, thread)) return false;
  if (text) {
    const haystack = eventSearchText(event);
    if (!haystack.includes(text)) return false;
  }
  return true;
}

function eventMethodSearchText(event) {
  const item = eventItem(event);
  const itemType = eventItemType(event);
  const itemId = eventItemId(event);
  return [
    event.method,
    event.rawJson?.method,
    event.itemType,
    item?.type,
    item?.status,
    `item.type=${itemType}`,
    `item.type === "${itemType}"`,
    `item.id=${itemId}`,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function eventSearchText(event) {
  const item = eventItem(event);
  const itemType = eventItemType(event);
  const itemId = eventItemId(event);
  return [
    event.summary,
    event.raw,
    event.method,
    event.rawJson?.method,
    event.sessionId,
    event.threadId,
    event.turnId,
    event.itemId,
    event.itemType,
    item?.id,
    item?.type,
    item?.status,
    item?.phase,
    item?.command,
    item?.cwd,
    item?.server,
    item?.tool,
    `item.type=${itemType}`,
    `item.type === "${itemType}"`,
    `item.id=${itemId}`,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function eventItem(event) {
  return event.rawJson?.params?.item || null;
}

function eventItemType(event) {
  return event.itemType || eventItem(event)?.type || "";
}

function eventItemId(event) {
  return event.itemId || eventItem(event)?.id || "";
}

function eventItemLabel(event) {
  const type = eventItemType(event);
  const id = eventItemId(event);
  if (!type && !id) return "";
  return [type, shortId(id)].filter(Boolean).join(" / ");
}

function eventMatchesThreadFilter(event, needle) {
  if (String(event.sessionId || "").toLowerCase().includes(needle)) return true;
  if (String(event.threadId || "").toLowerCase().includes(needle)) return true;
  const raw = event.rawJson;
  const params = raw?.params || {};
  const data = raw?.result?.data;
  if (String(params.sessionId || params.session_id || params.threadId || params.thread_id || params.parentThreadId || "").toLowerCase().includes(needle)) return true;
  if (Array.isArray(data)) {
    return data.some((item) => {
      const haystack = `${item?.sessionId || ""}\n${item?.session_id || ""}\n${item?.id || ""}\n${item?.threadId || ""}\n${item?.thread_id || ""}\n${item?.name || ""}\n${item?.title || ""}\n${item?.preview || ""}\n${item?.cwd || ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }
  return false;
}

function ingestEvent(event) {
  return { ...event, viewId: state.nextViewId++ };
}

function render() {
  state.renderScheduled = false;
  renderTabs();
  renderStorage();
  renderTokens();
  renderSessionsAndConversation();
  renderTimeline();
}

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(render);
}

function renderTabs() {
  const conversation = state.activeTab === "conversation";
  const tokens = state.activeTab === "tokens";
  const timeline = state.activeTab === "timeline";
  els.conversationView.classList.toggle("hidden", !conversation);
  els.tokensView.classList.toggle("hidden", !tokens);
  els.timelineView.classList.toggle("hidden", !timeline);
  els.conversationTabBtn.classList.toggle("active", conversation);
  els.tokensTabBtn.classList.toggle("active", tokens);
  els.timelineTabBtn.classList.toggle("active", timeline);
  els.liveLine.textContent = state.paused ? "paused" : "live";
  updateFollowLatestButton();
}

function renderStorage() {
  const storage = state.storage || state.status?.storage;
  if (!storage?.enabled) {
    els.storageSummary.textContent = "disabled";
    els.storageDetail.textContent = "Set CODEX_TRACE_STORAGE_ENABLED=true to persist review data.";
    return;
  }
  const size = storage.sizeBytes ?? storage.cachedSizeBytes ?? 0;
  const segments = storage.segmentCount ?? storage.cachedSegmentCount ?? 0;
  const pendingBytes = storage.pendingBytes ?? 0;
  const pendingEvents = storage.pendingEvents ?? 0;
  const lastFlush = storage.lastFlushTs ? ` / flush ${formatDateTime(storage.lastFlushTs)}` : "";
  els.storageSummary.textContent = `${formatBytes(size)} / ${segments} segments`;
  els.storageDetail.textContent = `${pendingEvents} pending (${formatBytes(pendingBytes)})${lastFlush}${storage.lastError ? ` / error: ${storage.lastError}` : ""}`;
}

function renderTokens() {
  const usage = state.tokenUsage;
  if (!usage) {
    els.tokensMeta.textContent = "Token usage has not been loaded.";
    setTokenSummaryValues(null);
    renderTokenTable(els.tokenThreadsTable, "thread", []);
    renderTokenTable(els.tokenTurnsTable, "turn", []);
    return;
  }
  if (!usage.enabled) {
    els.tokensMeta.textContent = "Storage is disabled, so token usage cannot be analyzed.";
    setTokenSummaryValues(null);
    renderTokenTable(els.tokenThreadsTable, "thread", []);
    renderTokenTable(els.tokenTurnsTable, "turn", []);
    return;
  }

  const latestTotal = usage.latestTotal || {};
  const latestLast = usage.latestLast || {};
  setTokenSummaryValues({ latestTotal, latestLast, modelContextWindow: usage.modelContextWindow });
  const range = usage.earliestTs && usage.latestTs ? `${formatDateTime(usage.earliestTs)} - ${formatDateTime(usage.latestTs)}` : "no token events";
  const error = usage.error ? ` / error: ${usage.error}` : "";
  els.tokensMeta.textContent = `${usage.eventCount || 0} events / ${usage.threadCount || 0} threads / ${usage.turnCount || 0} turns / ${range}${error}`;
  renderTokenTable(els.tokenThreadsTable, "thread", usage.topThreads || []);
  renderTokenTable(els.tokenTurnsTable, "turn", usage.topTurns || []);
}

function setTokenSummaryValues(summary) {
  if (!summary) {
    els.tokenTotalValue.textContent = "--";
    els.tokenInputValue.textContent = "--";
    els.tokenCachedValue.textContent = "--";
    els.tokenOutputValue.textContent = "--";
    els.tokenReasoningValue.textContent = "--";
    els.tokenContextValue.textContent = "--";
    return;
  }
  const total = summary.latestTotal || {};
  const last = summary.latestLast || {};
  const cachedRatio = total.inputTokens ? total.cachedInputTokens / total.inputTokens : 0;
  const reasoningRatio = total.outputTokens ? total.reasoningOutputTokens / total.outputTokens : 0;
  const contextRatio = summary.modelContextWindow ? last.totalTokens / summary.modelContextWindow : 0;
  els.tokenTotalValue.textContent = formatTokenCount(total.totalTokens);
  els.tokenInputValue.textContent = formatTokenCount(total.inputTokens);
  els.tokenCachedValue.textContent = `${formatTokenCount(total.cachedInputTokens)} / ${formatPercent(cachedRatio)}`;
  els.tokenOutputValue.textContent = formatTokenCount(total.outputTokens);
  els.tokenReasoningValue.textContent = `${formatTokenCount(total.reasoningOutputTokens)} / ${formatPercent(reasoningRatio)}`;
  els.tokenContextValue.textContent = summary.modelContextWindow ? `${formatPercent(contextRatio)} of ${formatTokenCount(summary.modelContextWindow)}` : "--";
}

function renderTokenTable(container, type, rows) {
  const idLabel = type === "thread" ? "Thread" : "Turn";
  const header = `
    <div class="tokenTableRow header">
      <span>${idLabel}</span>
      <span class="numeric">Total</span>
      <span class="numeric">Input</span>
      <span class="numeric">Cached</span>
      <span class="numeric">Output</span>
      <span class="numeric">Reasoning</span>
      <span class="numeric">Context</span>
    </div>
  `;
  if (!rows.length) {
    container.innerHTML = `${header}<div class="emptyState">No token usage events.</div>`;
    return;
  }
  container.innerHTML = header + rows.map((row) => tokenTableRow(row, type)).join("");
}

function tokenTableRow(row, type) {
  const totals = type === "thread" ? row.total || {} : row.last || {};
  const id = type === "thread" ? row.threadId : row.turnId;
  const title = type === "thread" ? row.threadId : `${row.turnId} / ${row.threadId || ""}`;
  return `
    <button class="tokenTableRow tokenDataRow" type="button" data-thread-id="${escapeHtml(row.threadId || "")}" data-turn-id="${escapeHtml(row.turnId || "")}" title="${escapeHtml(title || "")}">
      <span class="idCell">${escapeHtml(shortId(id))}</span>
      <span class="numeric">${escapeHtml(formatTokenCount(totals.totalTokens))}</span>
      <span class="numeric">${escapeHtml(formatTokenCount(totals.inputTokens))}</span>
      <span class="numeric">${escapeHtml(formatTokenCount(totals.cachedInputTokens))}</span>
      <span class="numeric">${escapeHtml(formatTokenCount(totals.outputTokens))}</span>
      <span class="numeric">${escapeHtml(formatTokenCount(totals.reasoningOutputTokens))}</span>
      <span class="numeric">${escapeHtml(formatPercent(row.contextUsageRatio))}</span>
    </button>
  `;
}

function renderSessionsAndConversation(options = {}) {
  const preserveConversation = Boolean(options.preserveConversation);
  const scrollPlan = preserveConversation ? captureConversationScrollPlan() : null;
  const model = filteredConversationModel() || buildConversationModel(state.events.filter(passesFilters), state.events);
  if (!state.selectedSessionId || !model.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = model.sessions[0]?.id || "";
    state.expandedSessionId = "";
    state.selectedThreadId = "";
    state.selectedTurnId = "";
    state.selectedSegmentKey = "";
    state.selectedAggregateKey = "";
    state.conversationViewSignature = "";
  }
  if (state.expandedSessionId && !model.sessions.some((session) => session.id === state.expandedSessionId)) {
    state.expandedSessionId = "";
  }
  renderSessionList(model.sessions);
  const selected = model.sessions.find((session) => session.id === state.selectedSessionId);
  const expanded = model.sessions.find((session) => session.id === state.expandedSessionId);
  const selectedThread = selected ? ensureSelectedThread(selected) : null;
  if (selectedThread?.detailLoaded === false) void ensureConversationThreadDetail(selectedThread.id);
  renderTurnOverlay(expanded);
  const nextSignature = conversationViewSignature(selected);
  if (preserveConversation && nextSignature && nextSignature === state.conversationViewSignature) {
    renderSegmentsActiveState();
    renderSegmentDetail(findSelectedSegment(selected));
    updateConversationFollowState();
    if (debugPerf) console.debug("[trace-viewer] preserve conversation render", { sessionId: selected?.id || "", signatureLength: nextSignature.length });
    return;
  }
  state.conversationViewSignature = nextSignature;
  renderConversation(selected, { scrollPlan, autoUpdate: Boolean(options.autoUpdate) });
}

function conversationViewSignature(session) {
  if (!session) return "";
  const thread = state.selectedThreadId ? sessionThreads(session).find((candidate) => candidate.id === state.selectedThreadId) : ensureSelectedThread(session);
  if (!thread) return `session:${session.id}:none`;
  const parts = [
    session.id,
    thread.id,
    state.turnSortDescending ? "desc" : "asc",
    String((thread.turns || []).length),
  ];
  for (const turn of thread.turns || []) {
    parts.push("turn", turn.id, String((turn.blocks || []).length), turn.status || "", String(turn.durationMs ?? ""));
    for (const block of turn.blocks || []) {
      parts.push(
        block.key || "",
        block.kind || "",
        block.role || "",
        block.label || "",
        block.meta || "",
        block.status || "",
        String(block.events?.length || block.eventCount || 0),
        String(block.firstSeq ?? ""),
        String(block.lastSeq ?? ""),
        String(block.firstTs || 0),
        String(block.lastTs || 0),
        truncateInline(block.preview || "", 160)
      );
    }
  }
  return parts.join("|");
}

function filteredConversationModel() {
  if (!state.conversationModel?.sessions) return null;
  const sessions = [];
  for (const session of state.conversationModel.sessions) {
    const filteredThreads = [];
    let events = 0;
    let blocks = 0;
    let turnCount = 0;
    let preview = "";
    for (const thread of session.threads || legacyThreads(session)) {
      if (thread.detailLoaded === false) {
        filteredThreads.push(thread);
        blocks += thread.blocks || 0;
        events += thread.events || 0;
        turnCount += thread.turnCount || thread.turns?.length || 0;
        if (!preview) preview = thread.preview || thread.threadPreview || "";
        continue;
      }
      const filteredTurns = [];
      let threadEvents = 0;
      let threadBlocks = 0;
      let threadPreview = "";
      for (const turn of thread.turns || []) {
        const visibleBlocks = (turn.blocks || []).filter((block) => !isLifecycleOnlyBlock(block));
        const filteredBlocks = visibleBlocks.filter((block) => blockMatchesFilters(block, session, thread, turn));
        if (!filteredBlocks.length) continue;
        filteredTurns.push({ ...turn, blocks: filteredBlocks });
        threadBlocks += filteredBlocks.length;
        threadEvents += filteredBlocks.reduce((sum, block) => sum + (block.eventCount || block.events?.length || 0), 0);
        if (!threadPreview) threadPreview = filteredBlocks.find((block) => block.preview)?.preview || "";
      }
      if (!filteredTurns.length && hasActiveConversationFilters()) continue;
      filteredThreads.push({
        ...thread,
        turns: filteredTurns,
        blocks: threadBlocks,
        events: threadEvents,
        preview: threadPreview || thread.preview,
      });
      blocks += threadBlocks;
      events += threadEvents;
      turnCount += filteredTurns.length;
      if (!preview) preview = threadPreview || thread.preview || thread.threadPreview || "";
    }
    if (!filteredThreads.length && hasActiveConversationFilters()) continue;
    sessions.push({
      ...session,
      threads: filteredThreads,
      threadCount: filteredThreads.length,
      turnCount,
      blocks,
      events,
      preview: preview || session.preview,
    });
  }
  return { sessions };
}

function isLifecycleOnlyBlock(block) {
  return block?.meta === "turn/start";
}

function hasActiveConversationFilters() {
  return Boolean(els.dirFilter.value || els.methodFilter.value.trim() || els.threadFilter.value.trim() || els.textFilter.value.trim());
}

function blockMatchesFilters(block, session, threadModel, turn) {
  const dir = els.dirFilter.value;
  const method = els.methodFilter.value.trim().toLowerCase();
  const thread = els.threadFilter.value.trim().toLowerCase();
  const text = els.textFilter.value.trim().toLowerCase();
  if (dir && !(block.events || []).some((event) => event.dir === dir)) return false;
  if (method) {
    const methods = blockMethodSearchText(block);
    if (!methods.includes(method)) return false;
  }
  if (thread) {
    const threadHaystack = `${session.id || ""}\n${session.sessionId || ""}\n${session.title || ""}\n${session.preview || ""}\n${session.cwd || ""}\n${threadModel.id || ""}\n${threadModel.threadId || ""}\n${threadModel.sessionId || ""}\n${threadModel.parentThreadId || ""}\n${threadModel.forkedFromId || ""}\n${threadModel.title || ""}\n${threadModel.threadPreview || ""}\n${threadModel.cwd || ""}\n${turn.id || ""}`.toLowerCase();
    if (!threadHaystack.includes(thread)) return false;
  }
  if (text) {
    const haystack = blockSearchText(block, session, threadModel, turn);
    if (!haystack.includes(text)) return false;
  }
  return true;
}

function blockMethodSearchText(block) {
  const itemType = block.itemType || "";
  return [
    block.meta,
    block.kind,
    block.role,
    block.label,
    itemType,
    `item.type=${itemType}`,
    `item.type === "${itemType}"`,
    ...(block.events || []).flatMap((event) => [event.method, event.itemType]),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function blockSearchText(block, session, threadModel, turn) {
  const itemType = block.itemType || "";
  return [
    block.preview,
    blockText(block),
    block.meta,
    block.kind,
    block.role,
    block.label,
    block.itemId,
    block.itemType,
    turn.id,
    threadModel.id,
    threadModel.threadId,
    session.id,
    session.sessionId,
    `item.type=${itemType}`,
    `item.type === "${itemType}"`,
    `item.id=${block.itemId || ""}`,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function sessionRenderSignature(session) {
  return [
    sessionTitle(session),
    session.source || "",
    session.threadCount || sessionThreads(session).length,
    session.turnCount || countTurns(session),
    session.blocks || 0,
    session.events || 0,
    session.preview || "",
  ].join("\u001f");
}

function createSessionListItem(session, signature) {
  const item = document.createElement("div");
  item.className = "sessionItem";
  item.dataset.sessionId = session.id;
  item.dataset.renderSignature = signature;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sessionRow";
  button.title = `${sessionTitle(session)}\n${session.id}`;
  button.innerHTML = `
    <span class="sessionName">${escapeHtml(sessionTitle(session))}</span>
    <span class="sessionId">${escapeHtml(sourceLabel(session.source))} / ${escapeHtml(shortId(session.id))}</span>
    <span class="sessionStats">${session.threadCount || sessionThreads(session).length} threads / ${session.turnCount || countTurns(session)} turns / ${session.blocks} blocks / ${session.events} events</span>
    <span class="sessionPreview">${escapeHtml(session.preview || "")}</span>
  `;
  button.addEventListener("click", () => {
    const switchingSession = state.selectedSessionId !== session.id;
    state.selectedSessionId = session.id;
    state.expandedSessionId = session.id;
    if (switchingSession) {
      state.selectedThreadId = "";
      state.selectedTurnId = "";
      state.selectedSegmentKey = "";
      state.selectedAggregateKey = "";
      state.conversationViewSignature = "";
    }
    render();
  });
  item.appendChild(button);
  return item;
}

function renderSessionList(sessions) {
  els.sessionCountLine.textContent = `${sessions.length}`;
  const existing = new Map(Array.from(els.sessionList.children).map((item) => [item.dataset.sessionId, item]));
  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    const signature = sessionRenderSignature(session);
    const previous = existing.get(session.id);
    const item = previous?.dataset.renderSignature === signature ? previous : createSessionListItem(session, signature);
    const selected = session.id === state.selectedSessionId;
    item.classList.toggle("selected", selected);
    item.querySelector(".sessionRow")?.classList.toggle("selected", selected);
    fragment.appendChild(item);
  }
  els.sessionList.replaceChildren(fragment);
}

function renderTurnOverlay(session) {
  const open = Boolean(session && state.expandedSessionId === session.id);
  els.turnOverlay.classList.toggle("open", open);
  els.turnOverlay.setAttribute("aria-hidden", String(!open));
  els.turnOverlayTitle.textContent = open ? sessionTitle(session) : "Turns";
  els.turnOverlayMeta.textContent = open
    ? `${sessionThreads(session).length} threads / ${countTurns(session)} turns / ${session.blocks} blocks / ${session.events} events`
    : "Select a session to inspect turns.";
  els.turnSortBtn.textContent = state.turnSortDescending ? "Desc" : "Asc";
  els.turnSortBtn.title = state.turnSortDescending ? "Turn order: newest first" : "Turn order: oldest first";
  els.turnOverlayList.innerHTML = "";
  if (!open) return;

  const threads = sessionThreads(session);
  if (!threads.length) {
    const empty = document.createElement("div");
    empty.className = "turnOverlayEmpty";
    empty.textContent = "No turns in the current filters.";
    els.turnOverlayList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  threads.forEach((threadModel) => {
    const threadHeader = document.createElement("button");
    threadHeader.type = "button";
    threadHeader.className = "turnThreadHeader";
    if (threadModel.id === state.selectedThreadId) threadHeader.classList.add("active");
    threadHeader.dataset.threadId = threadModel.id;
    threadHeader.title = `${threadTitle(threadModel)}\n${threadModel.id}`;
    threadHeader.innerHTML = `
      <span class="turnThreadName">${escapeHtml(threadTitle(threadModel))}</span>
      <span class="turnThreadId">${escapeHtml(shortId(threadModel.id))}</span>
    `;
    threadHeader.addEventListener("click", (event) => {
      event.stopPropagation();
      selectThread(threadModel.id);
    });
    fragment.appendChild(threadHeader);
    numberedTurnsForNav(threadModel).forEach(({ turn, number }) => {
      const button = document.createElement("button");
      const duration = turnDurationMs(turn);
      const durationText = duration != null ? durationLabel(duration) : "";
      const blockCount = turn.blockCount ?? turn.blocks.length;
      button.type = "button";
      button.className = "sessionTurnRow";
      if (turn.id === state.selectedTurnId && threadModel.id === state.selectedThreadId) button.classList.add("active");
      button.title = [
        `${shortId(threadModel.id)} / Turn ${number} / ${shortId(turn.id)} / ${blockCount} segments`,
        durationText ? `Duration: ${durationText}` : "",
        tokenUsageTitle(turn),
      ].filter(Boolean).join("\n");
      button.dataset.threadId = threadModel.id;
      button.dataset.turnId = turn.id;
      button.innerHTML = `
        <span class="turnRailIndex">${number}</span>
        <span class="turnRailText">${escapeHtml(turnLabel(turn, number))}</span>
        <span class="turnRailMeta">
          ${durationText ? `<span class="turnRailDuration">${escapeHtml(durationText)}</span>` : ""}
          <span class="turnRailCount">${blockCount}</span>
        </span>
      `;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selectTurn(threadModel.id, turn.id);
      });
      fragment.appendChild(button);
    });
  });
  els.turnOverlayList.appendChild(fragment);
}

function closeTurnOverlay() {
  state.expandedSessionId = "";
  render();
}

function renderConversation(session, options = {}) {
  const renderStart = debugPerf ? performance.now() : 0;
  let renderedBlocks = 0;
  if (!session) {
    els.conversationTitle.textContent = "No session selected";
    els.conversationMeta.textContent = "Select a session to inspect turns.";
    els.conversationMessages.innerHTML = `<div class="emptyState">No conversation events in the current filters.</div>`;
    renderSegmentRail(null, null);
    renderAggregateRail(null, null);
    renderSegmentDetail(null);
    return;
  }

  const selectedThread = ensureSelectedThread(session);
  if (state.selectedTurnId && !findTurnInSession(session, state.selectedThreadId, state.selectedTurnId)) {
    state.selectedTurnId = "";
    state.selectedSegmentKey = "";
    state.selectedAggregateKey = "";
  }

  const activeThread = selectedThread || ensureSelectedThread(session);
  const activeThreadBlocks = activeThread ? countThreadBlocks(activeThread) : 0;
  const rawSession = activeThread?.sessionId && activeThread.sessionId !== session.id ? `raw session ${activeThread.sessionId}` : "";
  const parent = activeThread?.parentThreadId ? `parent ${activeThread.parentThreadId}` : "";

  els.conversationTitle.textContent = activeThread ? threadTitle(activeThread) : sessionTitle(session);
  els.conversationMeta.textContent = [
    sourceLabel(activeThread?.source || session.source),
    `session ${session.id}`,
    activeThread ? `thread ${activeThread.id}` : "",
    rawSession,
    parent,
    session.cwd,
    activeThread ? `${activeThread.turns.length} turns` : `${countTurns(session)} turns`,
    `${activeThreadBlocks || session.blocks} blocks`,
  ].filter(Boolean).join(" / ");

  if (activeThread?.detailLoaded === false) {
    els.conversationMessages.innerHTML = `<div class="emptyState">Loading thread...</div>`;
    renderSegmentRail(null, null);
    renderAggregateRail(null, null);
    renderSegmentDetail(null);
    return;
  }

  const fragment = document.createDocumentFragment();
  const visibleThreads = activeThread ? [activeThread] : [];
  let defaultRailTurn = null;
  for (const threadModel of visibleThreads) {
    fragment.appendChild(threadDivider(threadModel));
    for (const { turn, number } of numberedTurnsForDisplay(threadModel)) {
      if (!defaultRailTurn) defaultRailTurn = { thread: threadModel, turn };
      buildAggregateGroups(turn.blocks || []);
      const blocks = blocksWithDisplayNumbers(turn);
      const timingByBlock = blockTimingMap(turn);
      if (state.turnSortDescending) {
        fragment.appendChild(turnLifecycleDivider(threadModel, turn, number, "end"));
        for (const { block, number } of blocks) {
          const timing = timingByBlock.get(block) || {};
          fragment.appendChild(segmentCard(block, threadModel, turn, number, timing));
          if (timing.gapMs >= longItemGapMs) fragment.appendChild(itemWaitDivider(timing.gapMs, `wait:${threadModel.id}:${turn.id}:${block.key}:after`));
          renderedBlocks += 1;
        }
        fragment.appendChild(turnLifecycleDivider(threadModel, turn, number, "start"));
      } else {
        fragment.appendChild(turnLifecycleDivider(threadModel, turn, number, "start"));
        for (const { block, number } of blocks) {
          const timing = timingByBlock.get(block) || {};
          if (timing.gapMs >= longItemGapMs) fragment.appendChild(itemWaitDivider(timing.gapMs, `wait:${threadModel.id}:${turn.id}:${block.key}:before`));
          fragment.appendChild(segmentCard(block, threadModel, turn, number, timing));
          renderedBlocks += 1;
        }
        fragment.appendChild(turnLifecycleDivider(threadModel, turn, number, "end"));
      }
    }
  }
  if (!fragment.childNodes.length) {
    els.conversationMessages.innerHTML = `<div class="emptyState">No blocks for the selected agent.</div>`;
    disconnectConversationResizeObserver();
  } else {
    reconcileConversationMessages(fragment);
  }
  const railTurn = currentRailTurn(activeThread, defaultRailTurn);
  renderSegmentRail(activeThread, railTurn);
  renderAggregateRail(activeThread, railTurn);
  renderSegmentDetail(findSelectedSegment(session));
  requestAnimationFrame(drawAggregateLinks);
  if (options.scrollPlan) {
    applyConversationScrollPlan(options.scrollPlan, { autoUpdate: Boolean(options.autoUpdate) });
  } else {
    updateConversationFollowState();
  }
  if (debugPerf) {
    console.debug("[trace-viewer] renderConversation", {
      ms: Math.round((performance.now() - renderStart) * 10) / 10,
      blocks: renderedBlocks,
      threadId: activeThread?.id || "",
    });
  }
}

function threadDivider(threadModel) {
  const el = document.createElement("div");
  el.className = "threadDivider";
  if (threadModel.id === state.selectedThreadId) el.classList.add("active");
  el.id = `thread-${cssSafeId(threadModel.id)}`;
  el.dataset.threadId = threadModel.id;
  const parent = threadModel.parentThreadId ? ` / parent ${shortId(threadModel.parentThreadId)}` : "";
  const fork = threadModel.forkedFromId ? ` / fork ${shortId(threadModel.forkedFromId)}` : "";
  el.innerHTML = `
    <span>${escapeHtml(threadTitle(threadModel))}</span>
    <span>${escapeHtml(shortId(threadModel.id))}${escapeHtml(parent)}${escapeHtml(fork)}</span>
  `;
  return registerConversationNode(el, `thread:${threadModel.id}`);
}

function turnLifecycleDivider(threadModel, turn, number, phase) {
  const el = document.createElement("div");
  el.className = `turnDivider turnLifecycleDivider turn${phase === "start" ? "Start" : "End"}`;
  if (turn.id === state.selectedTurnId && threadModel.id === state.selectedThreadId) el.classList.add("active");
  el.id = turnLifecycleId(threadModel.id, turn.id, phase);
  el.dataset.threadId = threadModel.id;
  el.dataset.turnId = turn.id;
  el.dataset.phase = phase;
  el.tabIndex = 0;
  const jumpTitle = phase === "start" ? "Click to jump to turn end" : "Click to jump to turn start";
  const phaseLabel = phase === "start" ? "start" : "end";
  const time = turnLifecycleTimeLabel(turn, phase);
  const duration = phase === "end" ? turnDurationMs(turn) : null;
  const durationText = duration != null ? `${turnEndMs(turn) ? "Worked" : "Running"} for ${durationLabel(duration)}` : "";
  const endSummary = [durationText, turn.status].filter(Boolean).join(" · ");
  el.title = [jumpTitle, phase === "end" ? [time, endSummary].filter(Boolean).join(" / ") : "", tokenUsageTitle(turn)].filter(Boolean).join("\n\n");
  el.innerHTML = `
    <span><strong>#${escapeHtml(String(number))}</strong> Turn ${escapeHtml(phaseLabel)} ${escapeHtml(shortId(turn.id))} / ${escapeHtml(time)}${endSummary ? ` / ${escapeHtml(endSummary)}` : ""}</span>
  `;
  conversationNodeContexts.set(el, { threadModel, turn, phase });
  const jump = () => {
    const context = conversationNodeContexts.get(el);
    if (!context) return;
    state.selectedThreadId = context.threadModel.id;
    state.selectedTurnId = context.turn.id;
    state.selectedSegmentKey = "";
    state.selectedAggregateKey = "";
    renderSegmentRail(context.threadModel, { thread: context.threadModel, turn: context.turn });
    renderAggregateRail(context.threadModel, { thread: context.threadModel, turn: context.turn });
    renderSegmentsActiveState();
    renderSegmentDetail(null);
    scrollToTurnLifecycle(context.threadModel.id, context.turn.id, context.phase === "start" ? "end" : "start", "center");
  };
  el.addEventListener("click", jump);
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    jump();
  });
  return registerConversationNode(el, `turn:${threadModel.id}:${turn.id}:${phase}`, conversationNodeContexts.get(el));
}

function registerConversationNode(element, key, context = null) {
  element.dataset.conversationKey = key;
  if (context) conversationNodeContexts.set(element, context);
  conversationNodeSignatures.set(element, conversationNodeRenderSignature(element));
  return element;
}

function conversationNodeRenderSignature(element) {
  const mutableClasses = new Set(["active", "jumpFlash", "selected"]);
  const classes = Array.from(element.classList).filter((name) => !mutableClasses.has(name)).join(" ");
  const attributes = Array.from(element.attributes)
    .filter((attribute) => attribute.name !== "class")
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .sort()
    .join("|");
  return `${element.tagName}|${classes}|${attributes}|${element.innerHTML}`;
}

function syncConversationNodeState(existing, next) {
  for (const className of ["active", "selected"]) {
    existing.classList.toggle(className, next.classList.contains(className));
  }
}

function reconcileConversationMessages(fragment) {
  const container = els.conversationMessages;
  const existingByKey = new Map();
  for (const child of Array.from(container.children)) {
    const key = child.dataset.conversationKey;
    if (key) existingByKey.set(key, child);
  }

  const nextChildren = Array.from(fragment.children);
  const retained = new Set();
  let reference = container.firstElementChild;
  for (const next of nextChildren) {
    const key = next.dataset.conversationKey;
    const existing = key ? existingByKey.get(key) : null;
    const canReuse = existing && conversationNodeSignatures.get(existing) === conversationNodeSignatures.get(next);
    let node = next;
    let positionHandled = false;
    if (canReuse) {
      const context = conversationNodeContexts.get(next);
      if (context) conversationNodeContexts.set(existing, context);
      syncConversationNodeState(existing, next);
      node = existing;
    } else if (existing) {
      const nextReference = existing.nextElementSibling;
      const wasReference = existing === reference;
      existing.replaceWith(next);
      if (wasReference) {
        reference = nextReference;
        positionHandled = true;
      }
    }
    retained.add(node);
    if (positionHandled) continue;
    if (node === reference) {
      reference = reference.nextElementSibling;
    } else {
      container.insertBefore(node, reference);
    }
  }
  for (const child of Array.from(container.children)) {
    if (!retained.has(child)) child.remove();
  }
  syncConversationResizeObserver();
}

function turnLifecycleTimeLabel(turn, phase) {
  const ms = turnLifecycleTimeMs(turn, phase);
  if (ms) return clockTime(ms);
  return phase === "end" && String(turn?.status || "").toLowerCase() === "inprogress" ? "in progress" : "not recorded";
}

function turnLifecycleTimeMs(turn, phase) {
  if (phase === "start") {
    return Number(turn.startedTs) || epochLikeToMs(turn.startedAt) || Number(turn.firstTs) || 0;
  }
  return Number(turn.completedTs) || epochLikeToMs(turn.completedAt) || 0;
}

function epochLikeToMs(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function turnLifecycleId(threadId, turnId, phase) {
  return `turn-${cssSafeId(threadId)}-${cssSafeId(turnId)}-${phase}`;
}

function conversationScrollDelta(container, target, block = "start") {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const padding = 16;
  if (block === "center") {
    return targetRect.top + targetRect.height / 2 - (containerRect.top + containerRect.height / 2);
  }
  if (block === "end") {
    return targetRect.bottom - containerRect.bottom + padding;
  }
  if (block === "nearest") {
    if (targetRect.top >= containerRect.top + padding && targetRect.bottom <= containerRect.bottom - padding) return 0;
    if (targetRect.top < containerRect.top + padding) return targetRect.top - containerRect.top - padding;
    return targetRect.bottom - containerRect.bottom + padding;
  }
  return targetRect.top - containerRect.top - padding;
}

function setConversationScrollTop(container, value) {
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.max(0, Math.min(max, value));
}

function flashJumpTarget(target) {
  if (!(target instanceof HTMLElement)) return;
  const previous = jumpFlashTimers.get(target);
  if (previous) window.clearTimeout(previous);
  target.classList.remove("jumpFlash");
  void target.offsetWidth;
  target.classList.add("jumpFlash");
  jumpFlashTimers.set(
    target,
    window.setTimeout(() => {
      target.classList.remove("jumpFlash");
      jumpFlashTimers.delete(target);
    }, 720),
  );
}

function jumpToConversationElement(target, block = "start", options = {}) {
  const container = els.conversationMessages;
  if (!(container instanceof HTMLElement) || !(target instanceof HTMLElement) || !container.contains(target)) return false;
  const apply = () => {
    const delta = conversationScrollDelta(container, target, block);
    if (Math.abs(delta) > 1) setConversationScrollTop(container, container.scrollTop + delta);
  };
  apply();
  if (options.settle !== false) window.requestAnimationFrame(apply);
  if (options.flash !== false) flashJumpTarget(target);
  return true;
}

function turnLifecycleElement(threadId, turnId, phase = null) {
  const targetPhase = phase || (state.turnSortDescending ? "end" : "start");
  return document.querySelector(`#${turnLifecycleId(threadId, turnId, targetPhase)}`);
}

function scrollToTurnLifecycle(threadId, turnId, phase = null, block = "start") {
  return jumpToConversationElement(turnLifecycleElement(threadId, turnId, phase), block);
}

function conversationLatestEdgeDistance(container = els.conversationMessages) {
  if (!(container instanceof HTMLElement)) return 0;
  if (state.turnSortDescending) return Math.max(0, container.scrollTop);
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.max(0, max - container.scrollTop);
}

function isConversationAtLatest(container = els.conversationMessages) {
  return conversationLatestEdgeDistance(container) <= conversationFollowEdgePx;
}

function scrollToLatestConversationEdge(container = els.conversationMessages) {
  if (!(container instanceof HTMLElement)) return;
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  setConversationScrollTop(container, state.turnSortDescending ? 0 : max);
}

function captureConversationScrollPlan() {
  const container = els.conversationMessages;
  if (!(container instanceof HTMLElement)) return null;
  const followLatest = isConversationAtLatest(container);
  return {
    followLatest,
    scrollTop: container.scrollTop,
    anchor: followLatest ? null : captureConversationScrollAnchor(container),
  };
}

function captureConversationScrollAnchor(container) {
  const containerRect = container.getBoundingClientRect();
  const candidates = Array.from(container.querySelectorAll(".segmentCard, .turnDivider, .threadDivider"));
  const visible = candidates.filter((element) => isConversationAnchorVisible(element, containerRect));
  const selected = visible.find((element) => element.classList.contains("segmentCard") && element.dataset.segmentKey === state.selectedSegmentKey);
  const target = selected || closestConversationAnchorToCenter(visible, containerRect) || candidates[0];
  if (!(target instanceof HTMLElement)) return null;
  const selector = conversationAnchorSelector(target);
  if (!selector) return null;
  return {
    selector,
    offsetTop: target.getBoundingClientRect().top - containerRect.top,
  };
}

function isConversationAnchorVisible(element, containerRect) {
  const rect = element.getBoundingClientRect();
  return rect.bottom > containerRect.top + 8 && rect.top < containerRect.bottom - 8;
}

function closestConversationAnchorToCenter(elements, containerRect) {
  const center = containerRect.top + containerRect.height / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const distance = Math.abs(rect.top + rect.height / 2 - center);
    if (distance < bestDistance) {
      best = element;
      bestDistance = distance;
    }
  }
  return best;
}

function conversationAnchorSelector(element) {
  if (element.classList.contains("segmentCard")) {
    const { threadId, turnId, segmentKey } = element.dataset;
    if (threadId && turnId && segmentKey) return segmentDomSelector(threadId, turnId, segmentKey);
  }
  if (element.classList.contains("turnDivider")) {
    const { threadId, turnId, phase } = element.dataset;
    if (threadId && turnId) return `#${turnLifecycleId(threadId, turnId, phase || null)}`;
  }
  if (element.classList.contains("threadDivider") && element.dataset.threadId) {
    return `#thread-${cssSafeId(element.dataset.threadId)}`;
  }
  return "";
}

function restoreConversationScrollAnchor(plan, container = els.conversationMessages) {
  if (!(container instanceof HTMLElement) || !plan?.anchor?.selector) return false;
  const target = container.querySelector(plan.anchor.selector);
  if (!(target instanceof HTMLElement) || !container.contains(target)) return false;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const nextScrollTop = container.scrollTop + targetRect.top - containerRect.top - plan.anchor.offsetTop;
  setConversationScrollTop(container, nextScrollTop);
  return true;
}

function applyConversationScrollPlan(plan, options = {}) {
  const container = els.conversationMessages;
  if (!(container instanceof HTMLElement) || !plan) {
    updateConversationFollowState();
    return;
  }
  const applyToken = beginConversationScrollApplication();
  state.conversationFollowLatest = plan.followLatest;
  if (options.autoUpdate && !plan.followLatest) {
    state.conversationUnreadUpdates = Math.min(99, state.conversationUnreadUpdates + 1);
  }
  if (plan.followLatest) {
    scrollToLatestConversationEdge(container);
    state.conversationUnreadUpdates = 0;
  } else if (!restoreConversationScrollAnchor(plan, container)) {
    setConversationScrollTop(container, plan.scrollTop || 0);
  }
  rememberConversationAnchorPosition(container);
  finishConversationScrollApplication(applyToken);
  updateFollowLatestButton();
}

function beginConversationScrollApplication() {
  state.conversationScrollApplying = true;
  conversationScrollApplyToken += 1;
  return conversationScrollApplyToken;
}

function finishConversationScrollApplication(token) {
  window.requestAnimationFrame(() => {
    if (token !== conversationScrollApplyToken) return;
    state.conversationScrollApplying = false;
    state.conversationFollowLatest = isConversationAtLatest();
    if (state.conversationFollowLatest) {
      state.conversationUnreadUpdates = 0;
      conversationObservedAnchor = null;
    } else if (!conversationObservedAnchor) {
      rememberConversationAnchorPosition();
    }
    updateFollowLatestButton();
  });
}

function rememberConversationAnchorPosition(container = els.conversationMessages) {
  if (!(container instanceof HTMLElement) || isConversationAtLatest(container)) {
    conversationObservedAnchor = null;
    return;
  }
  const anchor = captureConversationScrollAnchor(container);
  const element = anchor?.selector ? container.querySelector(anchor.selector) : null;
  conversationObservedAnchor = element instanceof HTMLElement ? { element, offsetTop: anchor.offsetTop } : null;
}

function ensureConversationResizeObserver() {
  if (conversationResizeObserver || typeof ResizeObserver === "undefined") return conversationResizeObserver;
  conversationResizeObserver = new ResizeObserver(() => {
    const container = els.conversationMessages;
    if (!(container instanceof HTMLElement) || state.activeTab !== "conversation") return;
    if (state.conversationFollowLatest) {
      const token = beginConversationScrollApplication();
      scrollToLatestConversationEdge(container);
      conversationObservedAnchor = null;
      finishConversationScrollApplication(token);
      return;
    }
    const anchor = conversationObservedAnchor;
    if (!(anchor?.element instanceof HTMLElement) || !anchor.element.isConnected || !container.contains(anchor.element)) {
      rememberConversationAnchorPosition(container);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const nextOffsetTop = anchor.element.getBoundingClientRect().top - containerRect.top;
    const delta = nextOffsetTop - anchor.offsetTop;
    if (Math.abs(delta) <= 0.5) return;
    const token = beginConversationScrollApplication();
    setConversationScrollTop(container, container.scrollTop + delta);
    anchor.offsetTop = anchor.element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    finishConversationScrollApplication(token);
  });
  return conversationResizeObserver;
}

function syncConversationResizeObserver() {
  const observer = ensureConversationResizeObserver();
  if (!observer) return;
  observer.disconnect();
  for (const element of els.conversationMessages.querySelectorAll(".segmentCard, .turnDivider, .threadDivider, .itemWaitDivider")) {
    observer.observe(element);
  }
}

function disconnectConversationResizeObserver() {
  conversationResizeObserver?.disconnect();
  conversationObservedAnchor = null;
}

function updateConversationFollowState() {
  if (state.conversationScrollApplying) return;
  state.conversationFollowLatest = isConversationAtLatest();
  if (state.conversationFollowLatest) state.conversationUnreadUpdates = 0;
  rememberConversationAnchorPosition();
  updateFollowLatestButton();
}

function updateFollowLatestButton() {
  if (!els.followLatestBtn) return;
  const show = state.activeTab === "conversation" && !state.conversationFollowLatest && state.conversationUnreadUpdates > 0;
  els.followLatestBtn.hidden = !show;
  if (show) {
    const count = state.conversationUnreadUpdates;
    els.followLatestBtn.textContent = `${count === 1 ? "1 update" : `${count} updates`} - Follow latest`;
  }
}

function turnLabel(turn, number) {
  if (turn.preview) return turn.preview;
  const user = turn.blocks.find((block) => block.role === "user");
  if (user) return userFacingUserText(blockText(user)) || user.preview || user.label || `Turn ${number}`;
  const first = turn.blocks.find((block) => block.preview || block.label);
  return displayPreview(first) || first?.label || `Turn ${number}`;
}

function numberedTurnsForNav(threadModel) {
  return numberedTurnsForDisplay(threadModel);
}

function numberedTurnsForDisplay(threadModel) {
  const turns = (threadModel.turns || []).map((turn, index) => ({ turn, number: index + 1 }));
  return state.turnSortDescending ? turns.reverse() : turns;
}

function blocksForDisplay(turn) {
  return blocksWithDisplayNumbers(turn).map((item) => item.block);
}

function blocksWithDisplayNumbers(turn) {
  const blocks = (turn.blocks || []).map((block, index) => ({ block, number: index + 1 }));
  return state.turnSortDescending ? blocks.reverse() : blocks;
}

function currentRailTurn(activeThread, fallback) {
  if (!activeThread) return null;
  if (state.selectedThreadId === activeThread.id && state.selectedTurnId) {
    const selectedTurn = (activeThread.turns || []).find((turn) => turn.id === state.selectedTurnId);
    if (selectedTurn) return { thread: activeThread, turn: selectedTurn };
  }
  return fallback || null;
}

function renderSegmentRail(activeThread, railTurn) {
  els.segmentRail.innerHTML = "";
  if (!activeThread || !railTurn?.turn) {
    els.segmentRail.classList.remove("open");
    return;
  }
  const blocks = blocksWithDisplayNumbers(railTurn.turn);
  if (!blocks.length) {
    els.segmentRail.classList.remove("open");
    return;
  }

  const fragment = document.createDocumentFragment();
  const timingByBlock = blockTimingMap(railTurn.turn);
  blocks.forEach(({ block, number }) => {
    const timing = timingByBlock.get(block) || {};
    const gapText = compactGapLabel(timing.gapMs);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segmentRailItem";
    if (block.key === state.selectedSegmentKey) button.classList.add("active");
    button.dataset.threadId = railTurn.thread.id;
    button.dataset.turnId = railTurn.turn.id;
    button.dataset.segmentKey = block.key;
    button.dataset.aggregateKey = block.aggregateKey || block.key;
    button.title = [
      `${number}. ${block.label || block.kind || "segment"} / ${block.meta || ""}`,
      timing.startMs ? `Started: ${clockTime(timing.startMs)}` : "",
      timing.gapMs != null ? `Gap from previous item: ${durationLabel(timing.gapMs)}` : "",
    ].filter(Boolean).join("\n");
    button.innerHTML = `
      <span class="segmentRailGap">${escapeHtml(gapText)}</span>
      <span class="segmentRailNumber">${number}</span>
      <span class="segmentRailKind">${escapeHtml(segmentRailLabel(block))}</span>
    `;
    button.addEventListener("click", () => {
      selectSegment(block, railTurn.thread, railTurn.turn);
      jumpToConversationElement(document.querySelector(segmentDomSelector(railTurn.thread.id, railTurn.turn.id, block.key)), "center");
    });
    fragment.appendChild(button);
  });
  els.segmentRail.appendChild(fragment);
  els.segmentRail.classList.add("open");
}

function renderAggregateRail(activeThread, railTurn) {
  els.aggregateRail.innerHTML = "";
  if (!activeThread || !railTurn?.turn) {
    state.selectedAggregateKey = "";
    els.aggregateRail.classList.remove("open");
    drawAggregateLinks();
    return;
  }

  const aggregates = buildAggregateRailGroups(railTurn.turn.blocks || []).filter(
    (group) => aggregateRailItemCount(group.key) > 1,
  );
  if (!aggregates.length) {
    state.selectedAggregateKey = "";
    els.aggregateRail.classList.remove("open");
    drawAggregateLinks();
    return;
  }

  if (!aggregates.some((group) => group.key === state.selectedAggregateKey)) {
    state.selectedAggregateKey = "";
  }

  const heading = document.createElement("div");
  heading.className = "aggregateRailHeader";
  heading.innerHTML = `<strong>Aggregate</strong><span>${aggregates.length}</span>`;
  els.aggregateRail.appendChild(heading);

  const list = document.createElement("div");
  list.className = "aggregateRailList";
  for (const group of aggregates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `aggregateCard kind-${cssSafeId(group.kind || "item")}`;
    if (group.key === state.selectedAggregateKey) button.classList.add("active");
    button.dataset.aggregateKey = group.key;
    button.dataset.aggregateKind = group.kind || "item";
    const itemNumbers = group.segments.map((segment) => (railTurn.turn.blocks || []).indexOf(segment) + 1);
    const visibleItemNumbers = itemNumbers.slice(0, 3).map((number) => `#${number}`).join(" · ");
    const itemSummary = itemNumbers.length > 3 ? `${visibleItemNumbers} +${itemNumbers.length - 3}` : visibleItemNumbers;
    button.title = `${group.label || group.kind || "aggregate"}\nItems ${itemNumbers.map((number) => `#${number}`).join(", ")}`;
    button.innerHTML = `
      <span class="aggregateCardTop">
        <strong>${escapeHtml(group.label || group.kind || "aggregate")}</strong>
        <span>${group.segments.length}</span>
      </span>
      <span class="aggregateCardItems">${escapeHtml(itemSummary)}</span>
    `;
    button.addEventListener("click", () => {
      state.selectedAggregateKey = group.key;
      renderAggregateActiveState();
      drawAggregateLinks();
    });
    list.appendChild(button);
  }
  els.aggregateRail.appendChild(list);
  els.aggregateRail.classList.add("open");
  renderAggregateActiveState();
}

function planStepState(status) {
  const value = String(status || "pending").toLowerCase();
  if (value.includes("complete")) return "completed";
  if (value.includes("progress") || value.includes("active")) return "active";
  if (value.includes("fail") || value.includes("error")) return "failed";
  return "pending";
}

function planStepStateLabel(state) {
  if (state === "completed") return "done";
  if (state === "active") return "doing";
  if (state === "failed") return "failed";
  return "todo";
}

function renderAggregateActiveState() {
  for (const card of document.querySelectorAll(".aggregateCard.active")) card.classList.remove("active");
  for (const item of document.querySelectorAll(".segmentRailItem.aggregateRelated")) item.classList.remove("aggregateRelated");
  if (!state.selectedAggregateKey) return;
  els.aggregateRail
    .querySelector(`.aggregateCard[data-aggregate-key="${cssEscape(state.selectedAggregateKey)}"]`)
    ?.classList.add("active");
  for (const item of els.segmentRail.querySelectorAll(
    `.segmentRailItem[data-aggregate-key="${cssEscape(state.selectedAggregateKey)}"]`,
  )) {
    item.classList.add("aggregateRelated");
  }
}

function aggregateRailItemCount(aggregateKey) {
  if (!aggregateKey) return 0;
  return els.segmentRail.querySelectorAll(
    `.segmentRailItem[data-aggregate-key="${cssEscape(aggregateKey)}"]`,
  ).length;
}

function drawAggregateLinks() {
  const svg = els.aggregateLinks;
  svg.replaceChildren();
  const frameRect = els.conversationMessages.parentElement.getBoundingClientRect();
  const width = Math.max(1, Math.round(frameRect.width));
  const height = Math.max(1, Math.round(frameRect.height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  drawSelectedItemLink(svg, frameRect);
  drawSelectedAggregateLinks(svg, frameRect);
}

function drawSelectedItemLink(svg, frameRect) {
  if (!state.selectedSegmentKey) return;
  const railItem = els.segmentRail.querySelector(
    `.segmentRailItem[data-thread-id="${cssEscape(state.selectedThreadId)}"][data-turn-id="${cssEscape(state.selectedTurnId)}"][data-segment-key="${cssEscape(state.selectedSegmentKey)}"]`,
  );
  const segment = document.querySelector(segmentDomSelector(state.selectedThreadId, state.selectedTurnId, state.selectedSegmentKey));
  if (!railItem || !segment) return;

  const railViewport = els.segmentRail.getBoundingClientRect();
  const messageViewport = els.conversationMessages.getBoundingClientRect();
  const railRect = railItem.getBoundingClientRect();
  const segmentRect = segment.getBoundingClientRect();
  if (!rectVerticallyVisible(railRect, railViewport)) return;

  const start = relativePoint(frameRect, railRect.right, railRect.top + railRect.height / 2);
  if (!rectVerticallyVisible(segmentRect, messageViewport)) {
    const direction = segmentRect.bottom < messageViewport.top ? -1 : 1;
    appendConnector(svg, start, { x: start.x + 28, y: start.y + direction * 18 }, "itemLink offscreen");
    return;
  }
  const end = relativePoint(frameRect, segmentRect.left, segmentRect.top + segmentRect.height / 2);
  appendConnector(svg, start, end, "itemLink", true);
}

function drawSelectedAggregateLinks(svg, frameRect) {
  if (!state.selectedAggregateKey || !els.aggregateRail.classList.contains("open")) return;
  const aggregate = els.aggregateRail.querySelector(
    `.aggregateCard[data-aggregate-key="${cssEscape(state.selectedAggregateKey)}"]`,
  );
  if (!aggregate) return;

  const aggregateRect = aggregate.getBoundingClientRect();
  const railViewport = els.segmentRail.getBoundingClientRect();
  const start = relativePoint(frameRect, aggregateRect.right, aggregateRect.top + aggregateRect.height / 2);
  const railItems = els.segmentRail.querySelectorAll(
    `.segmentRailItem[data-aggregate-key="${cssEscape(state.selectedAggregateKey)}"]`,
  );
  const offscreenAbove = [];
  const offscreenBelow = [];
  for (const item of railItems) {
    const rect = item.getBoundingClientRect();
    if (rect.bottom < railViewport.top) {
      offscreenAbove.push({ item, rect });
      continue;
    }
    if (rect.top > railViewport.bottom) {
      offscreenBelow.push({ item, rect });
      continue;
    }
    const end = relativePoint(frameRect, rect.left, rect.top + rect.height / 2);
    appendConnector(svg, start, end, `aggregateLink kind-${cssSafeId(aggregate.dataset.aggregateKind || "item")}`, true);
  }
  drawOffscreenAggregateLinks(svg, start, frameRect, railViewport, offscreenAbove, -1);
  drawOffscreenAggregateLinks(svg, start, frameRect, railViewport, offscreenBelow, 1);
}

function drawOffscreenAggregateLinks(svg, start, frameRect, railViewport, entries, direction) {
  if (!entries.length) return;
  const railEdgeX = railViewport.left - frameRect.left - 22;
  const end = {
    x: Math.min(railEdgeX, start.x + 68),
    y: Math.max(14, Math.min(frameRect.height - 14, start.y + direction * 52)),
  };
  const path = appendConnector(
    svg,
    start,
    end,
    `aggregateLink offscreen offscreen-${direction < 0 ? "above" : "below"}`,
  );
  path.dataset.offscreenDirection = direction < 0 ? "above" : "below";
  path.dataset.offscreenCount = String(entries.length);
  appendOffscreenCount(svg, end, entries.length, direction);
}

function appendOffscreenCount(svg, point, count, direction) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "aggregateLinkCount");
  group.setAttribute("transform", `translate(${point.x + 12} ${point.y})`);
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = `${count} related items ${direction < 0 ? "above" : "below"} the visible rail`;
  group.appendChild(title);
  const badge = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  badge.setAttribute("r", "10");
  badge.setAttribute("class", "aggregateLinkCountBadge");
  group.appendChild(badge);
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("class", "aggregateLinkCountText");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.textContent = String(count);
  group.appendChild(text);
  svg.appendChild(group);
}

function appendConnector(svg, start, end, className, showEndDot = false) {
  const bendX = start.x + (end.x - start.x) * 0.5;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${start.x} ${start.y} C ${bendX} ${start.y}, ${bendX} ${end.y}, ${end.x} ${end.y}`);
  path.setAttribute("class", className);
  svg.appendChild(path);
  if (!showEndDot) return path;
  for (const point of [start, end]) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(point.x));
    dot.setAttribute("cy", String(point.y));
    dot.setAttribute("r", "3");
    dot.setAttribute("class", "aggregateLinkDot");
    svg.appendChild(dot);
  }
  return path;
}

function relativePoint(frameRect, x, y) {
  return { x: x - frameRect.left, y: y - frameRect.top };
}

function rectVerticallyVisible(rect, viewport) {
  return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
}

function segmentRailLabel(block) {
  if (isContextCompactionBlock(block)) return "compact";
  return block.label || block.kind || block.role || "segment";
}

function turnNumber(threadModel, turn) {
  const index = (threadModel.turns || []).findIndex((candidate) => candidate.id === turn.id);
  return index >= 0 ? index + 1 : "";
}

function selectThread(threadId) {
  state.selectedThreadId = threadId;
  state.selectedTurnId = "";
  state.selectedSegmentKey = "";
  state.selectedAggregateKey = "";
  state.conversationViewSignature = "";
  render();
}

function findThreadTurnInSession(session, threadId, turnId) {
  if (!session) return null;
  for (const thread of sessionThreads(session)) {
    if (threadId && thread.id !== threadId) continue;
    const turn = (thread.turns || []).find((candidate) => candidate.id === turnId);
    if (turn) return { thread, turn };
  }
  return null;
}

function selectTurn(threadId, turnId) {
  state.selectedThreadId = threadId;
  state.selectedTurnId = turnId;
  state.selectedSegmentKey = "";
  state.selectedAggregateKey = "";
  const session = state.conversationModel?.sessions?.find((candidate) => candidate.id === state.selectedSessionId);
  const match = findThreadTurnInSession(session, threadId, turnId);
  if (match && turnLifecycleElement(threadId, turnId)) {
    renderSegmentRail(match.thread, { thread: match.thread, turn: match.turn });
    renderAggregateRail(match.thread, { thread: match.thread, turn: match.turn });
    renderSegmentsActiveState();
    renderSegmentDetail(null);
    scrollToTurnLifecycle(threadId, turnId);
    return;
  }
  state.conversationViewSignature = "";
  render();
  requestAnimationFrame(() => scrollToTurnLifecycle(threadId, turnId));
}

function cssSafeId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value || ""));
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function segmentDomId(threadId, turnId, segmentKey) {
  return `segment-${cssSafeId(threadId)}-${cssSafeId(turnId)}-${cssSafeId(segmentKey)}`;
}

function segmentDomSelector(threadId, turnId, segmentKey) {
  return `#${segmentDomId(threadId, turnId, segmentKey)}`;
}

function segmentCard(block, threadModel, turn, number = "", timing = {}) {
  const article = document.createElement("article");
  article.className = `messageBlock segmentCard role-${block.role}`;
  if (isContextCompactionBlock(block)) article.classList.add("contextCompactionMarker");
  if (block.key === state.selectedSegmentKey) article.classList.add("selected");
  article.id = segmentDomId(threadModel.id, turn.id, block.key);
  article.tabIndex = 0;
  article.dataset.threadId = threadModel.id;
  article.dataset.turnId = turn.id;
  article.dataset.segmentKey = block.key;
  article.dataset.aggregateKey = block.aggregateKey || block.key;
  article.dataset.segmentNumber = number;
  const startText = timing.startMs ? clockTime(timing.startMs) : eventTime(block.events[0] || {});
  const gapText = compactGapLabel(timing.gapMs);
  if (isContextCompactionBlock(block)) {
    article.innerHTML = contextCompactionMarkup(block, number, timing);
    conversationNodeContexts.set(article, { block, threadModel, turn });
    article.addEventListener("click", () => selectConversationSegmentElement(article));
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectConversationSegmentElement(article);
      }
    });
    return registerConversationNode(article, `segment:${threadModel.id}:${turn.id}:${block.key}`, conversationNodeContexts.get(article));
  }
  const preview = segmentPreview(block);
  const contentMarkup = block.kind === "plan" ? planSegmentMarkup(block) : `<div class="segmentPreview">${escapeHtml(preview)}</div>`;
  article.innerHTML = `
    <div class="messageMeta">
      <span class="segmentNumberBadge">${escapeHtml(String(number))}</span>
      <span class="roleBadge">${escapeHtml(block.label)}</span>
      <span>${escapeHtml(block.meta)}</span>
      <span class="segmentStartTime">${escapeHtml(startText)}</span>
      ${gapText ? `<span class="segmentGap" title="Gap from previous item: ${escapeHtml(durationLabel(timing.gapMs))}">${escapeHtml(gapText)}</span>` : ""}
      ${block.aggregateParts > 1 ? `<span class="aggregatePartBadge">part ${block.aggregatePart}/${block.aggregateParts}</span>` : ""}
      <span>${block.events.length} events</span>
    </div>
    ${contentMarkup}
  `;
  conversationNodeContexts.set(article, { block, threadModel, turn });
  article.addEventListener("click", () => selectConversationSegmentElement(article));
  article.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectConversationSegmentElement(article);
    }
  });
  return registerConversationNode(article, `segment:${threadModel.id}:${turn.id}:${block.key}`, conversationNodeContexts.get(article));
}

function planSegmentMarkup(block) {
  const plan = Array.isArray(block.plan) ? block.plan : [];
  if (!plan.length) return `<div class="segmentPreview">${escapeHtml(segmentPreview(block))}</div>`;
  const steps = plan.map((item) => ({
    state: planStepState(item.status),
    step: String(item.step || "Plan step"),
  }));
  const completed = steps.filter((item) => item.state === "completed").length;
  const progress = Math.round((completed / steps.length) * 100);
  return `
    <div class="planContent">
      <div class="planContentSummary">
        <span><strong>${completed}/${steps.length}</strong> completed</span>
        <span>${steps.length} steps</span>
      </div>
      <div class="planProgressTrack" role="progressbar" aria-label="Plan progress" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${completed}">
        <span class="planProgressFill" style="width: ${progress}%"></span>
      </div>
      <ol class="planStepList">
        ${steps
          .map(
            (item) => `
              <li class="planStepItem status-${item.state}">
                <span class="planStepStatus">${escapeHtml(planStepStateLabel(item.state))}</span>
                <span class="planStepText">${escapeHtml(item.step)}</span>
              </li>
            `,
          )
          .join("")}
      </ol>
    </div>
  `;
}

function selectConversationSegmentElement(element) {
  const context = conversationNodeContexts.get(element);
  if (!context) return;
  selectSegment(context.block, context.threadModel, context.turn);
}

function isContextCompactionBlock(block) {
  return block?.meta === "contextCompaction" || block?.itemType === "contextCompaction";
}

function contextCompactionMarkup(block, number = "", timing = {}) {
  const started = eventTime(block.events?.[0] || {});
  const completed = eventTime(block.events?.at?.(-1) || block.events?.[block.events.length - 1] || {});
  const duration = blockDurationLabel(block);
  const gap = compactGapLabel(timing.gapMs);
  const itemId = block.itemId ? `item ${shortId(block.itemId)}` : "";
  const seqRange = block.firstSeq != null && block.lastSeq != null ? `seq ${block.firstSeq}-${block.lastSeq}` : "";
  return `
    <div class="contextCompactionLine" aria-label="Context compacted">
      <span class="contextCompactionRule"></span>
      <span class="segmentNumberBadge contextCompactionNumber">${escapeHtml(String(number))}</span>
      <span class="contextCompactionBadge">Context compacted</span>
      <span class="contextCompactionMeta">${escapeHtml([itemId, started, gap, completed && completed !== started ? `done ${completed}` : "", duration, seqRange, `${block.events?.length || 0} events`].filter(Boolean).join(" / "))}</span>
      <span class="contextCompactionRule"></span>
    </div>
  `;
}

function itemWaitDivider(gapMs, key) {
  const el = document.createElement("div");
  el.className = "itemWaitDivider";
  el.setAttribute("aria-label", `Waited ${durationLabel(gapMs)}`);
  el.innerHTML = `<span>waited ${escapeHtml(durationLabel(gapMs))}</span>`;
  return registerConversationNode(el, key);
}

function blockDurationLabel(block) {
  if (block.durationMs != null) return durationLabel(block.durationMs);
  const start = Number(block.firstTs || block.events?.[0]?.ts_ms || 0);
  const end = Number(block.lastTs || block.events?.[block.events.length - 1]?.ts_ms || 0);
  if (!start || !end || end <= start) return "";
  return durationLabel(end - start);
}

function segmentPreview(block) {
  if (isContextCompactionBlock(block)) return contextCompactionDetailText(block);
  const text = compactBlockPreviewSource(block).replace(/\s+/g, " ").trim();
  return truncateInline(text || "(empty)", 360);
}

function compactBlockPreviewSource(block) {
  if (!block) return "";
  if (block.preview && block.preview !== block.kind && block.preview !== block.role) return String(block.preview);
  if (block.kind === "command") {
    return [block.command, block.status ? `status: ${block.status}` : "", block.exitCode != null ? `exit=${block.exitCode}` : "", previewSnippet(block.output)].filter(Boolean).join(" / ");
  }
  if (block.kind === "tool") {
    return [`${block.server || "mcp"}.${block.tool || "tool"}`, previewSnippet(block.error || block.resultText || block.argumentsText)].filter(Boolean).join(" / ");
  }
  if (block.kind === "webSearch") {
    return previewSnippet(block.preview || block.text || webSearchBlockDetail(block));
  }
  if (block.kind === "file") {
    const changes = block.changes || [];
    const paths = changes.map((change) => change.path).filter(Boolean).slice(0, 3).join(", ");
    return `${changes.length} file changes${paths ? ` / ${paths}` : ""}`;
  }
  if (block.kind === "plan") {
    return (block.plan || []).slice(0, 4).map((item) => `[${item.status}] ${item.step}`).join(" / ");
  }
  if (block.kind === "diff") return previewSnippet(block.diff);
  if (block.kind === "image") return [block.revisedPrompt, block.savedPath].filter(Boolean).join(" / ");
  return previewSnippet(block.text || block.summary || block.preview || block.label || "");
}

function previewSnippet(value, max = 520) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)} ...`;
}

function contextCompactionDetailText(block) {
  const started = eventTime(block.events?.[0] || {});
  const completed = eventTime(block.events?.at?.(-1) || block.events?.[block.events.length - 1] || {});
  const lines = ["Conversation context was compacted."];
  if (block.itemId) lines.push(`itemId: ${block.itemId}`);
  if (started) lines.push(`started: ${started}`);
  if (completed && completed !== started) lines.push(`completed: ${completed}`);
  const duration = blockDurationLabel(block);
  if (duration) lines.push(`duration: ${duration}`);
  if (block.firstSeq != null || block.lastSeq != null) lines.push(`seq: ${[block.firstSeq, block.lastSeq].filter((value) => value != null).join(" - ")}`);
  lines.push(`events: ${block.events?.length || 0}`);
  return lines.join("\n");
}

function displayPreview(block, body = null) {
  if (!block) return "";
  const source = body ?? blockText(block) ?? block.preview ?? block.label ?? "";
  const text = block.role === "user" ? userFacingUserText(source) : String(source || "");
  return text.replace(/\s+/g, " ").trim();
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

function selectSegment(block, threadModel, turn) {
  state.selectedThreadId = threadModel.id;
  state.selectedTurnId = turn.id;
  state.selectedSegmentKey = block.key;
  const aggregateKey = block.aggregateKey || block.key;
  state.selectedAggregateKey = buildAggregateRailGroups(turn.blocks || []).some((group) => group.key === aggregateKey)
    ? aggregateKey
    : "";
  renderSegmentsActiveState();
  renderAggregateActiveState();
  renderSegmentDetail({ block, thread: threadModel, turn });
  drawAggregateLinks();
}

function renderSegmentsActiveState() {
  for (const card of document.querySelectorAll(".segmentCard.selected")) {
    card.classList.remove("selected");
  }
  if (state.selectedThreadId && state.selectedTurnId && state.selectedSegmentKey) {
    document.querySelector(segmentDomSelector(state.selectedThreadId, state.selectedTurnId, state.selectedSegmentKey))?.classList.add("selected");
  }
  for (const item of document.querySelectorAll(".segmentRailItem.active")) {
    item.classList.remove("active");
  }
  if (state.selectedThreadId && state.selectedTurnId && state.selectedSegmentKey) {
    document
      .querySelector(`.segmentRailItem[data-thread-id="${cssEscape(state.selectedThreadId)}"][data-turn-id="${cssEscape(state.selectedTurnId)}"][data-segment-key="${cssEscape(state.selectedSegmentKey)}"]`)
      ?.classList.add("active");
  }
  for (const divider of document.querySelectorAll(".turnDivider.active")) {
    divider.classList.remove("active");
  }
  for (const divider of document.querySelectorAll(".threadDivider.active")) {
    divider.classList.remove("active");
  }
  if (state.selectedThreadId) {
    document.querySelector(`#thread-${cssSafeId(state.selectedThreadId)}`)?.classList.add("active");
  }
  if (state.selectedThreadId && state.selectedTurnId) {
    document
      .querySelectorAll(`.turnDivider[data-thread-id="${cssEscape(state.selectedThreadId)}"][data-turn-id="${cssEscape(state.selectedTurnId)}"]`)
      .forEach((divider) => divider.classList.add("active"));
  }
  for (const row of document.querySelectorAll(".sessionTurnRow.active")) {
    row.classList.remove("active");
  }
  if (state.selectedThreadId && state.selectedTurnId) {
    document.querySelector(`.sessionTurnRow[data-thread-id="${cssEscape(state.selectedThreadId)}"][data-turn-id="${cssEscape(state.selectedTurnId)}"]`)?.classList.add("active");
  }
}

function findSelectedSegment(session) {
  if (!state.selectedSegmentKey) return null;
  for (const threadModel of sessionThreads(session)) {
    for (const turn of threadModel.turns) {
      const block = turn.blocks.find((candidate) => candidate.key === state.selectedSegmentKey);
      if (block) return { block, thread: threadModel, turn };
    }
  }
  state.selectedSegmentKey = "";
  state.selectedAggregateKey = "";
  return null;
}

function renderSegmentDetail(selection) {
  if (!selection) {
    els.segmentDetail.classList.remove("open");
    syncSegmentDetailOpen();
    els.segmentDetailTitle.textContent = "Segment detail";
    els.segmentDetailMeta.textContent = "Select a segment.";
    els.segmentContentPre.textContent = "Select a turn segment to inspect content.";
    renderSegmentEncodingControls(null);
    els.segmentRawMeta.textContent = "Select a segment.";
    segmentRawSelection = null;
    segmentContentModeKey = "";
    segmentContentMode = "original";
    segmentRawEventIndex = 0;
    segmentRawLoadToken += 1;
    closeSegmentRaw();
    return;
  }
  const { block, thread, turn } = selection;
  const outputEncoding = validOutputEncoding(block.outputEncoding);
  if (segmentContentModeKey !== block.key) {
    segmentContentModeKey = block.key;
    segmentContentMode = outputEncoding?.defaultDisplay === "recovered" ? "recovered" : "original";
  }
  if (!outputEncoding) segmentContentMode = "original";
  const commandOutput = segmentContentMode === "recovered" ? outputEncoding?.recoveredText : block.output;
  const body = isContextCompactionBlock(block)
    ? contextCompactionDetailText(block)
    : blockText(block, { commandOutput }) || "(empty)";
  const displayedBody = truncateForDisplay(body);
  const truncated = displayedBody.length !== body.length;
  const totalEvents = totalBlockEventCount(block);
  if (segmentRawSelection?.block?.key !== block.key) {
    segmentRawEventIndex = 0;
    segmentRawLoadToken += 1;
  }
  segmentRawSelection = selection;
  els.segmentDetail.classList.add("open");
  syncSegmentDetailOpen();
  els.segmentDetailTitle.textContent = isContextCompactionBlock(block) ? "Context compacted" : `${block.label} / ${block.meta || block.kind}`;
  els.segmentDetailMeta.textContent = [`Thread ${shortId(thread.id)}`, `Turn ${shortId(turn.id)}`, `${totalEvents} events`, eventTime(block.events[0] || {})].filter(Boolean).join(" / ");
  els.segmentContentPre.textContent = `${displayedBody}${truncated ? "\n\n[display truncated]" : ""}`;
  renderSegmentEncodingControls(outputEncoding);
  if (els.segmentRawModal.classList.contains("open")) renderSegmentEventDetails();
}

function validOutputEncoding(value) {
  if (!value || typeof value !== "object" || typeof value.recoveredText !== "string") return null;
  return value;
}

function renderSegmentEncodingControls(outputEncoding) {
  const visible = Boolean(outputEncoding);
  els.segmentEncodingControls.hidden = !visible;
  if (!visible) {
    els.segmentEncodingBadge.textContent = "";
    els.segmentEncodingBadge.title = "";
    return;
  }
  const percent = Math.round((Number(outputEncoding.confidence) || 0) * 100);
  const partial = outputEncoding.recovery === "partial";
  els.segmentEncodingBadge.className = `segmentEncodingBadge ${partial ? "partial" : "exact"}`;
  els.segmentEncodingBadge.textContent = partial ? `UTF-8 recovered partially · ${percent}%` : `UTF-8 recovered · ${percent}%`;
  els.segmentEncodingBadge.title = (outputEncoding.evidence || []).join("\n");
  const recovered = segmentContentMode === "recovered";
  els.segmentRecoveredBtn.classList.toggle("active", recovered);
  els.segmentOriginalBtn.classList.toggle("active", !recovered);
  els.segmentRecoveredBtn.setAttribute("aria-pressed", String(recovered));
  els.segmentOriginalBtn.setAttribute("aria-pressed", String(!recovered));
}

function openSegmentRaw() {
  if (!state.selectedSegmentKey || !segmentRawSelection) return;
  els.segmentRawModal.classList.add("open");
  els.segmentRawBackdrop.classList.add("open");
  setSegmentRawTab("original");
  renderSegmentEventDetails();
}

function closeSegmentRaw() {
  els.segmentRawModal.classList.remove("open");
  els.segmentRawBackdrop.classList.remove("open");
  segmentRawLoadToken += 1;
}

function totalBlockEventCount(block) {
  return Math.max(Number(block?.eventCount) || 0, block?.events?.length || 0);
}

function renderSegmentEventDetails() {
  const selection = segmentRawSelection;
  if (!selection) return;
  const { block, thread, turn } = selection;
  const events = block.events || [];
  const totalEvents = totalBlockEventCount(block);
  const omittedEvents = Math.max(Number(block.omittedEventCount) || 0, totalEvents - events.length, 0);
  segmentRawEventIndex = clamp(segmentRawEventIndex, 0, Math.max(0, events.length - 1));
  els.segmentRawMeta.textContent = [
    `Thread ${shortId(thread.id)}`,
    `Turn ${shortId(turn.id)}`,
    `${totalEvents} events`,
    events.length !== totalEvents ? `${events.length} sampled` : "",
  ].filter(Boolean).join(" / ");
  els.segmentEventSummary.textContent = omittedEvents
    ? `${events.length} sampled / ${totalEvents} total / ${omittedEvents} omitted`
    : `${events.length} events`;
  els.segmentEventList.innerHTML = segmentEventListMarkup(block, events, omittedEvents);
  for (const button of els.segmentEventList.querySelectorAll(".segmentEventRow")) {
    button.addEventListener("click", () => selectSegmentRawEvent(Number(button.dataset.eventIndex) || 0));
  }
  if (!events.length) {
    renderSegmentOriginal(null, null, "No sampled events are available for this segment.");
    renderSegmentProcessed(null, null);
    return;
  }
  selectSegmentRawEvent(segmentRawEventIndex);
}

function segmentEventListMarkup(block, events, omittedEvents) {
  const headEvents = Math.max(0, Number(block.rawSample?.headEvents) || 3);
  return events
    .map((event, index) => {
      const omitted = omittedEvents && index === Math.min(headEvents, events.length)
        ? `<div class="segmentEventOmitted">${omittedEvents} events omitted</div>`
        : "";
      return `${omitted}
        <button class="segmentEventRow${index === segmentRawEventIndex ? " active" : ""}" type="button" data-event-index="${index}">
          <span class="segmentEventRowTop">
            <span class="segmentEventRowSeq">#${escapeHtml(String(event.seq ?? "?"))}</span>
            <span class="segmentEventRowMeta">${escapeHtml(eventTime(event))}</span>
          </span>
          <span class="segmentEventRowMethod">${escapeHtml(event.method || "(no method)")}</span>
          <span class="segmentEventRowMeta"><span>${escapeHtml(event.dir || "unknown")}</span><span>${escapeHtml(event.itemType || "")}</span></span>
        </button>`;
    })
    .join("");
}

function selectSegmentRawEvent(index) {
  const block = segmentRawSelection?.block;
  const events = block?.events || [];
  if (!events.length) return;
  segmentRawEventIndex = clamp(index, 0, events.length - 1);
  for (const button of els.segmentEventList.querySelectorAll(".segmentEventRow")) {
    button.classList.toggle("active", Number(button.dataset.eventIndex) === segmentRawEventIndex);
  }
  const sample = events[segmentRawEventIndex];
  const cacheKey = exactEventDetailsKey(sample);
  const exact = cacheKey ? exactEventDetailsCache.get(cacheKey) : null;
  renderSegmentOriginal(sample, exact);
  renderSegmentProcessed(sample, exact);
  if (!exact && cacheKey) void loadExactEventDetails(sample, cacheKey, segmentRawEventIndex);
}

async function loadExactEventDetails(sample, cacheKey, selectedIndex) {
  const token = ++segmentRawLoadToken;
  setSegmentOriginalStatus("loading", `Loading complete message for seq ${sample.seq}...`);
  try {
    const params = new URLSearchParams({ seq: String(sample.seq), ts_ms: String(sample.ts_ms || "") });
    if (sample.sourceId) params.set("sourceId", sample.sourceId);
    if (sample.connectionId) params.set("connectionId", sample.connectionId);
    const response = await fetch(`/api/event-details?${params}`);
    const details = await response.json();
    if (!response.ok) throw new Error(details.error || `HTTP ${response.status}`);
    exactEventDetailsCache.set(cacheKey, details);
    while (exactEventDetailsCache.size > 32) exactEventDetailsCache.delete(exactEventDetailsCache.keys().next().value);
    if (token !== segmentRawLoadToken || selectedIndex !== segmentRawEventIndex || !els.segmentRawModal.classList.contains("open")) return;
    renderSegmentOriginal(sample, details);
    renderSegmentProcessed(sample, details);
  } catch (error) {
    if (token !== segmentRawLoadToken || selectedIndex !== segmentRawEventIndex) return;
    renderSegmentOriginal(sample, null, `Complete message unavailable: ${error.message}. Showing the compact Viewer sample.`);
    renderSegmentProcessed(sample, null, error.message);
  }
}

function exactEventDetailsKey(event) {
  if (event?.seq == null) return "";
  return [event.seq, event.ts_ms || "", event.sourceId || "", event.connectionId || ""].join(":");
}

function renderSegmentOriginal(sample, details, error = "") {
  if (!sample) {
    setSegmentOriginalStatus("error", error || "No event selected.");
    els.segmentOriginalPre.textContent = "";
    return;
  }
  if (details) {
    const original = details.original || {};
    const body = original.json != null ? JSON.stringify(original.json, null, 2) : String(original.raw || "");
    const status = original.parseError
      ? `Complete captured payload / parse error: ${original.parseError}`
      : `Complete app-server message / ${details.source || "exact source"}`;
    setSegmentOriginalStatus(original.parseError ? "error" : "complete", status);
    els.segmentOriginalPre.textContent = body || "(empty message)";
    return;
  }
  const body = sample.rawJson != null ? JSON.stringify(sample.rawJson, null, 2) : String(sample.raw || "");
  setSegmentOriginalStatus(error ? "error" : "sampled", error || "Compact Viewer sample while the complete message is loading.");
  els.segmentOriginalPre.textContent = body || "(empty sample)";
}

function setSegmentOriginalStatus(kind, text) {
  els.segmentOriginalStatus.className = `segmentOriginalStatus ${kind}`;
  els.segmentOriginalStatus.textContent = text;
}

function renderSegmentProcessed(sample, details, loadError = "") {
  const selection = segmentRawSelection;
  if (!selection) return;
  const { block } = selection;
  const capture = details?.capture || captureFieldsFromSample(sample);
  const derived = details?.derived || derivedFieldsFromSample(sample);
  const totalEvents = totalBlockEventCount(block);
  const omittedEvents = Math.max(Number(block.omittedEventCount) || 0, totalEvents - (block.events?.length || 0), 0);
  els.segmentProcessedContent.innerHTML = [
    processedGroupMarkup("Capture metadata", capture),
    processedGroupMarkup("Extracted identity", derived),
    processedGroupMarkup("Viewer segment", {
      kind: block.kind,
      role: block.role,
      label: block.label,
      meta: block.meta,
      status: block.status,
      segmentKey: block.key,
      aggregateKey: block.aggregateKey || block.key,
      aggregatePart: block.aggregateParts > 1 ? `${block.aggregatePart} / ${block.aggregateParts}` : null,
      eventCount: totalEvents,
      sampledEvents: block.events?.length || 0,
      omittedEventCount: omittedEvents,
      firstSeq: block.firstSeq,
      lastSeq: block.lastSeq,
      contentTruncated: Boolean(block.contentTruncated),
    }),
    processedGroupMarkup("Processing", {
      originalMessage: details ? "complete" : "compact sample",
      detailSource: details?.source || "conversation model",
      rawParse: derived.rawParseError || derived.parseError || "success",
      loadError: loadError || null,
    }),
    block.outputEncoding
      ? processedGroupMarkup("Encoding recovery", {
          pattern: block.outputEncoding.pattern,
          sourceEncoding: block.outputEncoding.sourceEncoding,
          targetEncoding: block.outputEncoding.targetEncoding,
          confidence: block.outputEncoding.confidence,
          recovery: block.outputEncoding.recovery,
          defaultDisplay: block.outputEncoding.defaultDisplay,
          aggregateConfidence: block.outputEncoding.aggregateConfidence,
          aggregateRecovery: block.outputEncoding.aggregateRecovery,
          repairedLines: block.outputEncoding.repairedLines,
          repairedChars: block.outputEncoding.repairedChars,
          replacementCount: block.outputEncoding.replacementCount,
          evidence: block.outputEncoding.evidence,
        })
      : "",
  ].join("");
}

function captureFieldsFromSample(event = {}) {
  return {
    schema: event.schema,
    seq: event.seq,
    ts_ms: event.ts_ms,
    pid: event.pid,
    dir: event.dir,
    source: event.source,
    sourceId: event.sourceId,
    transport: event.transport,
    connectionId: event.connectionId,
    codec: event.codec,
  };
}

function derivedFieldsFromSample(event = {}) {
  return {
    method: event.method,
    requestId: event.requestId,
    sessionId: event.sessionId,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId,
    itemType: event.itemType,
    summary: event.summary,
    parseError: event.parseError,
    rawParseError: event.rawParseError,
  };
}

function processedGroupMarkup(title, values) {
  const rows = Object.entries(values || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(formatProcessedValue(value))}</dd>`)
    .join("");
  return `<section class="processedGroup"><div class="processedGroupTitle">${escapeHtml(title)}</div><dl class="processedGrid">${rows}</dl></section>`;
}

function formatProcessedValue(value) {
  if (value === null || value === "") return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function setSegmentRawTab(tab) {
  segmentRawActiveTab = tab === "processed" ? "processed" : "original";
  const original = segmentRawActiveTab === "original";
  els.segmentOriginalTab.classList.toggle("active", original);
  els.segmentProcessedTab.classList.toggle("active", !original);
  els.segmentOriginalTab.setAttribute("aria-selected", String(original));
  els.segmentProcessedTab.setAttribute("aria-selected", String(!original));
  els.segmentOriginalPanel.classList.toggle("active", original);
  els.segmentProcessedPanel.classList.toggle("active", !original);
  els.segmentOriginalPanel.hidden = !original;
  els.segmentProcessedPanel.hidden = original;
}

function syncSegmentDetailOpen() {
  els.chatShell.classList.toggle("detailOpen", els.segmentDetail.classList.contains("open"));
  requestAnimationFrame(drawAggregateLinks);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sessionPaneWidthBounds(rect = els.conversationView.getBoundingClientRect()) {
  return { min: 240, max: Math.max(260, rect.width - 420) };
}

function setSessionPaneWidth(width, bounds = sessionPaneWidthBounds()) {
  const next = clamp(width, bounds.min, bounds.max);
  document.documentElement.style.setProperty("--session-pane-width", `${Math.round(next)}px`);
  return next;
}

function segmentDetailWidthBounds(rect = els.chatShell.getBoundingClientRect()) {
  return { min: 340, max: Math.max(340, rect.width - 560) };
}

function setSegmentDetailWidth(width, bounds = segmentDetailWidthBounds()) {
  const next = clamp(width, bounds.min, bounds.max);
  document.documentElement.style.setProperty("--segment-detail-width", `${Math.round(next)}px`);
  requestAnimationFrame(drawAggregateLinks);
  return next;
}

function initSplitters() {
  initPointerResize(els.conversationSplitter, {
    axis: "x",
    bodyClass: "resizingVertical",
    createDrag: () => {
      const viewRect = els.conversationView.getBoundingClientRect();
      const handleRect = els.conversationSplitter.getBoundingClientRect();
      const bounds = sessionPaneWidthBounds(viewRect);
      const initialValue = clamp(handleRect.left - viewRect.left, bounds.min, bounds.max);
      return {
        initialValue,
        ghostRect: {
          height: viewRect.height,
          left: viewRect.left + initialValue,
          top: viewRect.top,
          width: handleRect.width || 6,
        },
        valueFromEvent: (event) => clamp(event.clientX - viewRect.left, bounds.min, bounds.max),
        commit: (value) => setSessionPaneWidth(value, bounds),
      };
    },
  });

  initPointerResize(els.detailSplitter, {
    axis: "x",
    bodyClass: "resizingVertical",
    createDrag: () => {
      const shellRect = els.chatShell.getBoundingClientRect();
      const handleRect = els.detailSplitter.getBoundingClientRect();
      if (!handleRect.width) return null;
      const widthBounds = segmentDetailWidthBounds(shellRect);
      const cssWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--segment-detail-width"));
      const initialWidth = clamp(Number.isFinite(cssWidth) ? cssWidth : shellRect.right - handleRect.right, widthBounds.min, widthBounds.max);
      const positionBounds = {
        min: shellRect.width - handleRect.width - widthBounds.max,
        max: shellRect.width - handleRect.width - widthBounds.min,
      };
      const initialValue = clamp(shellRect.width - handleRect.width - initialWidth, positionBounds.min, positionBounds.max);
      return {
        initialValue,
        ghostRect: {
          height: shellRect.height,
          left: shellRect.left + initialValue,
          top: shellRect.top,
          width: handleRect.width || 6,
        },
        valueFromEvent: (event) => clamp(event.clientX - shellRect.left, positionBounds.min, positionBounds.max),
        commit: (value) => setSegmentDetailWidth(shellRect.width - handleRect.width - value, widthBounds),
      };
    },
  });
}

function initPointerResize(handle, { axis, bodyClass, createDrag }) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const drag = createDrag(event);
    if (!drag) return;
    const ghost = createSplitterGhost(axis, drag.ghostRect);
    let latestValue = drag.initialValue;
    let latestEvent = event;
    let frame = 0;

    const updateGhost = () => {
      frame = 0;
      latestValue = drag.valueFromEvent(latestEvent);
      const delta = latestValue - drag.initialValue;
      ghost.style.transform = axis === "x" ? `translate3d(${Math.round(delta)}px, 0, 0)` : `translate3d(0, ${Math.round(-delta)}px, 0)`;
    };

    const scheduleGhostUpdate = (moveEvent) => {
      latestEvent = moveEvent;
      if (!frame) frame = requestAnimationFrame(updateGhost);
    };

    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    if (bodyClass) document.body.classList.add(bodyClass);
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      moveEvent.preventDefault();
      scheduleGhostUpdate(moveEvent);
    };
    const end = (endEvent) => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (endEvent.type !== "pointercancel") {
        latestValue = drag.valueFromEvent(endEvent);
        drag.commit(latestValue);
      }
      ghost.remove();
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      if (bodyClass) document.body.classList.remove(bodyClass);
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
}

function createSplitterGhost(axis, rect) {
  const ghost = document.createElement("div");
  ghost.className = `splitterGhost splitterGhost-${axis}`;
  ghost.style.left = `${Math.round(rect.left)}px`;
  ghost.style.top = `${Math.round(rect.top)}px`;
  ghost.style.width = `${Math.round(rect.width)}px`;
  ghost.style.height = `${Math.round(rect.height)}px`;
  document.body.appendChild(ghost);
  return ghost;
}

function sessionThreads(session) {
  return session?.threads || legacyThreads(session);
}

function legacyThreads(session) {
  if (!session?.turns) return [];
  return [
    {
      id: session.id,
      threadId: session.id,
      sessionId: session.id,
      title: session.title || "",
      cwd: session.cwd || "",
      threadPreview: session.threadPreview || "",
      preview: session.preview || "",
      events: session.events || 0,
      blocks: session.blocks || 0,
      lastTs: session.lastTs || 0,
      source: session.source || "",
      turns: session.turns || [],
    },
  ];
}

function countTurns(session) {
  return sessionThreads(session).reduce((sum, thread) => sum + (thread.turns?.length || 0), 0);
}

function countThreadBlocks(thread) {
  if (thread?.detailLoaded === false) return thread.blocks || 0;
  return (thread?.turns || []).reduce((sum, turn) => sum + (turn.blocks?.length || 0), 0);
}

function ensureSelectedThread(session) {
  const threads = sessionThreads(session);
  if (!threads.length) {
    state.selectedThreadId = "";
    state.selectedTurnId = "";
    state.selectedSegmentKey = "";
    state.selectedAggregateKey = "";
    return null;
  }
  const selected = state.selectedThreadId ? threads.find((thread) => thread.id === state.selectedThreadId) : null;
  if (selected) return selected;
  state.selectedThreadId = threads[0].id;
  state.selectedTurnId = "";
  state.selectedSegmentKey = "";
  state.selectedAggregateKey = "";
  return threads[0];
}

function findTurnInSession(session, threadId, turnId) {
  return sessionThreads(session).some((thread) => {
    if (threadId && thread.id !== threadId) return false;
    return (thread.turns || []).some((turn) => turn.id === turnId);
  });
}

function findSessionForThreadTurn(threadId, turnId = "") {
  const sessions = state.conversationModel?.sessions || [];
  for (const session of sessions) {
    for (const thread of sessionThreads(session)) {
      if (threadId && thread.id !== threadId) continue;
      if (turnId && !(thread.turns || []).some((turn) => turn.id === turnId)) continue;
      return { session, thread };
    }
  }
  return null;
}

function sessionTitle(session) {
  if (session?.kind === "temporary" || session?.id === temporarySessionId) return temporarySessionTitle;
  return session.title || session.preview || `Session ${shortId(session.id)}`;
}

function threadTitle(thread) {
  const subject = thread.title || thread.threadPreview || thread.preview || `Thread ${shortId(thread.id)}`;
  const agent = agentLabel(thread);
  return subject ? `${agent} · ${subject}` : agent;
}

function agentLabel(thread) {
  const nickname = thread.agentNickname || "";
  const role = thread.agentRole || "";
  if (nickname && role) return `${nickname} (${role})`;
  if (nickname) return nickname;
  if (role) return role;
  if (thread.forkedFromId) return "side session";
  if (thread.ephemeral === true && thread.threadSource === "system") return "system helper";
  if (thread.ephemeral === true) return "temporary";
  return thread.parentThreadId ? "subagent" : "main agent";
}

function truncateForDisplay(value) {
  const text = String(value);
  if (text.length <= maxDisplayedBlockChars) return text;
  const head = Math.floor(maxDisplayedBlockChars * 0.72);
  const tail = maxDisplayedBlockChars - head;
  return `${text.slice(0, head)}\n\n... ${text.length - maxDisplayedBlockChars} chars omitted ...\n\n${text.slice(-tail)}`;
}

function boundedBlockValue(value) {
  const text = String(value || "");
  if (text.length <= maxStoredBlockChars) return text;
  const head = Math.floor(maxStoredBlockChars * 0.72);
  const tail = maxStoredBlockChars - head;
  return `${text.slice(0, head)}\n\n... ${text.length - maxStoredBlockChars} chars omitted while aggregating UI block ...\n\n${text.slice(-tail)}`;
}

function appendBlockValue(existing, addition) {
  return boundedBlockValue(`${existing || ""}${addition || ""}`);
}

function blockText(block, options = {}) {
  if (block.kind === "command") {
    const parts = [];
    if (block.command) parts.push(`$ ${block.command}`);
    if (block.cwd) parts.push(`cwd: ${block.cwd}`);
    if (block.status || block.exitCode != null || block.durationMs != null) {
      parts.push(`status: ${[block.status, block.exitCode != null ? `exit=${block.exitCode}` : "", durationLabel(block.durationMs)].filter(Boolean).join(" / ")}`);
    }
    const output = options.commandOutput ?? block.output;
    if (output) parts.push(output);
    return parts.join("\n\n");
  }
  if (block.kind === "tool") {
    const parts = [`${block.server || "mcp"}.${block.tool || "tool"}`];
    if (block.argumentsText) parts.push(block.argumentsText);
    if (block.resultText) parts.push(block.resultText);
    if (block.error) parts.push(`error: ${block.error}`);
    return parts.join("\n\n");
  }
  if (block.kind === "webSearch") return block.text || webSearchBlockDetail(block);
  if (block.kind === "file") {
    return (block.changes || []).map((change) => `${change.kind?.type || "change"} ${change.path || ""}\n${change.diff || ""}`).join("\n\n");
  }
  if (block.kind === "plan") {
    return (block.plan || []).map((item) => `[${item.status}] ${item.step}`).join("\n");
  }
  if (block.kind === "diff") return block.diff || "";
  if (block.kind === "image") return [block.revisedPrompt, block.savedPath].filter(Boolean).join("\n\n");
  return block.text || block.summary || "";
}

function showBlockRaw(block) {
  state.selectedViewId = null;
  const raw = block.events.map((event) => {
    const { viewId: _viewId, ...displayEvent } = event;
    return displayEvent;
  });
  els.detailPre.textContent = JSON.stringify(raw, null, 2);
  els.detailPanel.classList.add("open");
  els.detailBackdrop.classList.add("open");
}

function buildConversationModel(events, allEvents = events) {
  const threadMetadata = buildThreadMetadata(allEvents);
  const sessionMap = new Map();
  for (const event of events) {
    const threadId = event.threadId || event.rawJson?.params?.threadId || event.rawJson?.params?.thread_id;
    if (!threadId) continue;
    const metadata = threadMetadata.get(threadId);
    const sessionId = resolveDisplaySessionId(sessionMap, threadMetadata, threadId, metadata, event.sessionId || threadId);
    const session = getSession(sessionMap, sessionId);
    const thread = getThread(session, threadId);
    thread.displaySessionId = session.id;
    applyThreadMetadata(thread, metadata, event.sessionId);
    applySessionMetadata(session, thread);
    session.events += 1;
    thread.events += 1;
    session.lastTs = Math.max(session.lastTs || 0, event.ts_ms || 0);
    thread.lastTs = Math.max(thread.lastTs || 0, event.ts_ms || 0);
    session.source = mergeSourceLabel(session.source, event.source);
    thread.source = mergeSourceLabel(thread.source, event.source);
    const extracted = extractConversationEvent(event);
    if (!extracted && isTokenUsageEvent(event)) {
      applyTokenUsageToTurn(thread, event);
    }
    if (!extracted && isTurnLifecycleEvent(event)) {
      applyTurnLifecycle(thread, event);
    }
    if (!extracted) continue;
    const turnId = extracted.turnId || event.turnId || "unknown-turn";
    const turn = getTurn(thread, turnId);
    applyTurnMeta(turn, event);
    if (extracted.block) {
      applyBlock(turn, extracted.block, event);
      if (!thread.preview && extracted.block.preview) thread.preview = extracted.block.preview;
      if (!session.preview && extracted.block.preview) session.preview = extracted.block.preview;
    }
  }
  const sessions = [...sessionMap.values()];
  for (const session of sessions) {
    session.blocks = 0;
    session.turnCount = 0;
    session.threadCount = session.threads.length;
    for (const thread of session.threads) {
      thread.turns.sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
      thread.blocks = 0;
      for (const turn of thread.turns) {
        turn.blocks.sort((a, b) => (a.firstSeq || 0) - (b.firstSeq || 0));
        thread.blocks += turn.blocks.length;
      }
      session.blocks += thread.blocks;
      session.turnCount += thread.turns.length;
    }
    session.threads.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  }
  sessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return { sessions: groupTemporarySessions(sessions) };
}

function getSession(map, id) {
  if (!map.has(id)) {
    map.set(id, { id, sessionId: id, title: "", cwd: "", threadsById: new Map(), threads: [], events: 0, blocks: 0, turnCount: 0, threadCount: 0, preview: "", lastTs: 0, source: "" });
  }
  return map.get(id);
}

function getThread(session, id) {
  if (!session.threadsById.has(id)) {
    const thread = {
      id,
      threadId: id,
      sessionId: session.id,
      displaySessionId: session.id,
      title: "",
      cwd: "",
      threadPreview: "",
      turnsById: new Map(),
      turns: [],
      pendingTokenUsageByTurnId: new Map(),
      events: 0,
      blocks: 0,
      preview: "",
      lastTs: 0,
      source: "",
      parentThreadId: "",
      forkedFromId: "",
      agentNickname: "",
      agentRole: "",
      ephemeral: null,
      threadSource: "",
    };
    session.threadsById.set(id, thread);
    session.threads.push(thread);
  }
  return session.threadsById.get(id);
}

function groupTemporarySessions(sessions) {
  const normalSessions = [];
  const temporarySession = {
    id: temporarySessionId,
    sessionId: temporarySessionId,
    title: temporarySessionTitle,
    cwd: "",
    threads: [],
    events: 0,
    blocks: 0,
    turnCount: 0,
    threadCount: 0,
    preview: "",
    lastTs: 0,
    source: "",
    kind: "temporary",
    virtual: true,
  };

  for (const session of sessions) {
    if (!isTemporaryRootSession(session)) {
      normalSessions.push(session);
      continue;
    }
    temporarySession.threads.push(...sessionThreads(session));
    temporarySession.events += session.events || 0;
    temporarySession.blocks += session.blocks || 0;
    temporarySession.turnCount += session.turnCount || countTurns(session);
    temporarySession.lastTs = Math.max(temporarySession.lastTs || 0, session.lastTs || 0);
    temporarySession.source = mergeSourceLabel(temporarySession.source, session.source);
    if (!temporarySession.preview && session.preview) temporarySession.preview = session.preview;
  }

  if (temporarySession.threads.length) {
    temporarySession.threads.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    temporarySession.threadCount = temporarySession.threads.length;
    temporarySession.source ||= "local";
    normalSessions.push(temporarySession);
  }

  return normalSessions;
}

function isTemporaryRootSession(session) {
  const rootThreads = sessionThreads(session).filter((thread) => !thread.parentThreadId && !thread.forkedFromId);
  return rootThreads.length > 0 && rootThreads.every((thread) => isTemporaryRootThread(thread));
}

function isTemporaryRootThread(thread) {
  if (!thread || thread.parentThreadId || thread.forkedFromId) return false;
  if (thread.ephemeral === true) return true;
  if (thread.ephemeral === false) return false;
  if (thread.threadSource === "system") return true;
  return isMetadataGapRootThread(thread);
}

function isMetadataGapRootThread(thread) {
  const hasContent = (thread.blocks || 0) > 0 || (thread.turns || []).some((turn) => (turn.blocks || []).length > 0);
  return !hasContent && !thread.title && !thread.threadPreview && !thread.preview && !thread.cwd;
}

function resolveDisplaySessionId(sessionMap, metadataMap, threadId, metadata, fallbackSessionId, seen = new Set()) {
  if (!threadId || seen.has(threadId)) return fallbackSessionId || threadId;
  seen.add(threadId);
  const linkedThreadId = metadata?.parentThreadId || metadata?.forkedFromId;
  if (!linkedThreadId) return metadata?.sessionId || fallbackSessionId || threadId;

  const existingLinkedSessionId = findSessionIdForThread(sessionMap, linkedThreadId);
  if (existingLinkedSessionId) return existingLinkedSessionId;

  const linkedMetadata = metadataMap.get(linkedThreadId);
  if (linkedMetadata) {
    return resolveDisplaySessionId(sessionMap, metadataMap, linkedThreadId, linkedMetadata, linkedMetadata.sessionId || linkedThreadId, seen);
  }

  return linkedThreadId;
}

function findSessionIdForThread(sessionMap, threadId) {
  for (const session of sessionMap.values()) {
    if (session.threadsById?.has(threadId)) return session.id;
  }
  return "";
}

function buildThreadMetadata(events) {
  const metadata = new Map();
  for (const event of events) {
    const directId = stringValue(event.threadId);
    if (directId && (event.threadName || event.threadPreview || event.threadCwd)) {
      mergeThreadMetadata(metadata, {
        id: directId,
        sessionId: stringValue(event.sessionId),
        title: stringValue(event.threadName),
        preview: stringValue(event.threadPreview),
        cwd: stringValue(event.threadCwd),
        ephemeral: booleanValue(event.threadEphemeral),
        threadSource: stringValue(event.threadSource),
        updatedAt: numericTimestamp(event.ts_ms),
      });
    }
    mergeRawThreadMetadata(metadata, event.rawJson?.result?.thread);
    const data = event.rawJson?.result?.data;
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      mergeRawThreadMetadata(metadata, item);
    }
  }
  return metadata;
}

function mergeRawThreadMetadata(metadata, item) {
  if (!item || typeof item !== "object") return;
  const id = stringValue(item.id || item.threadId || item.thread_id);
  if (!id) return;
  const ephemeral = booleanValue(item.ephemeral);
  const threadSource = stringValue(item.threadSource || item.thread_source);
  mergeThreadMetadata(metadata, {
    id,
    sessionId: stringValue(item.sessionId || item.session_id),
    parentThreadId: stringValue(item.parentThreadId || item.parent_thread_id),
    forkedFromId: stringValue(item.forkedFromId || item.forked_from_id),
    agentNickname: stringValue(item.agentNickname || item.agent_nickname),
    agentRole: stringValue(item.agentRole || item.agent_role),
    ephemeral,
    threadSource,
    title: stringValue(item.name || item.title),
    preview: stringValue(item.preview),
    cwd: stringValue(item.cwd || item.path),
    updatedAt: numericTimestamp(item.updatedAt ?? item.updated_at ?? item.recencyAt ?? item.recency_at ?? item.createdAt ?? item.created_at),
  });
}

function mergeThreadMetadata(metadata, next) {
  const hasRelationMetadata =
    (next.ephemeral !== null && next.ephemeral !== undefined) ||
    Boolean(next.threadSource) ||
    Boolean(next.parentThreadId) ||
    Boolean(next.forkedFromId) ||
    Boolean(next.agentNickname) ||
    Boolean(next.agentRole);
  if (!next.id || (!next.title && !next.preview && !next.cwd && !next.sessionId && !hasRelationMetadata)) return;
  const current = metadata.get(next.id) || {
    updatedAt: 0,
    title: "",
    preview: "",
    cwd: "",
    sessionId: "",
    parentThreadId: "",
    forkedFromId: "",
    agentNickname: "",
    agentRole: "",
    ephemeral: null,
    threadSource: "",
  };
  const newer = next.updatedAt >= current.updatedAt;
  const title = chooseMetadataText(current.title, next.title, newer);
  const preview = chooseMetadataText(current.preview, next.preview, newer);
  const cwd = chooseMetadataText(current.cwd, next.cwd, newer);
  metadata.set(next.id, {
    updatedAt: Math.max(current.updatedAt, next.updatedAt),
    title,
    preview,
    cwd,
    sessionId: next.sessionId || current.sessionId || next.id,
    parentThreadId: next.parentThreadId || current.parentThreadId || "",
    forkedFromId: next.forkedFromId || current.forkedFromId || "",
    agentNickname: next.agentNickname || current.agentNickname || "",
    agentRole: next.agentRole || current.agentRole || "",
    ephemeral: next.ephemeral !== null && next.ephemeral !== undefined ? next.ephemeral : current.ephemeral,
    threadSource: next.threadSource || current.threadSource || "",
  });
}

function chooseMetadataText(current, next, newer) {
  if (!next) return current;
  if (!current) return next;
  if (current.length >= next.length && looksLikeDamagedText(next)) return current;
  return newer ? next : current;
}

function applyThreadMetadata(thread, metadata, rawSessionId = "") {
  if (!metadata) return;
  if (metadata.title) thread.title = metadata.title;
  if (metadata.preview) thread.threadPreview = metadata.preview;
  if (metadata.cwd) thread.cwd = metadata.cwd;
  if (metadata.sessionId || rawSessionId) thread.sessionId = metadata.sessionId || rawSessionId;
  if (metadata.parentThreadId) thread.parentThreadId = metadata.parentThreadId;
  if (metadata.forkedFromId) thread.forkedFromId = metadata.forkedFromId;
  if (metadata.agentNickname) thread.agentNickname = metadata.agentNickname;
  if (metadata.agentRole) thread.agentRole = metadata.agentRole;
  if (metadata.ephemeral !== null && metadata.ephemeral !== undefined) thread.ephemeral = metadata.ephemeral;
  if (metadata.threadSource) thread.threadSource = metadata.threadSource;
}

function applySessionMetadata(session, thread) {
  if (!thread) return;
  const rootLike = thread.id === session.id || (!thread.parentThreadId && !thread.forkedFromId);
  if (rootLike || !session.title) {
    if (thread.title) session.title = thread.title;
    if (thread.cwd) session.cwd = thread.cwd;
  }
  if (!session.preview && (thread.threadPreview || thread.preview)) session.preview = thread.threadPreview || thread.preview;
}

function mergeSourceLabel(current, next) {
  const value = next || "local";
  if (!current) return value;
  if (current === value) return current;
  return "mixed";
}

function stringValue(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return looksLikeDamagedText(text) ? "" : text;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
  }
  return null;
}

function looksLikeDamagedText(text) {
  return String(text || "").includes("\uFFFD");
}

function numericTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getTurn(session, id) {
  if (!session.turnsById.has(id)) {
    const turn = {
      id,
      blocksByKey: new Map(),
      blocks: [],
      firstTs: 0,
      status: "",
      durationMs: null,
      startedAt: null,
      completedAt: null,
      startedTs: 0,
      completedTs: 0,
      startedSeq: null,
      completedSeq: null,
      error: null,
    };
    session.turnsById.set(id, turn);
    session.turns.push(turn);
    const pendingTokenUsage = session.pendingTokenUsageByTurnId?.get(id);
    if (pendingTokenUsage) {
      turn.tokenUsage = pendingTokenUsage;
      session.pendingTokenUsageByTurnId.delete(id);
    }
  }
  return session.turnsById.get(id);
}

function isTurnLifecycleEvent(event) {
  const method = event.method || event.rawJson?.method;
  return (method === "turn/started" || method === "turn/completed") && Boolean(event.rawJson?.params?.turn?.id);
}

function applyTurnLifecycle(thread, event) {
  const turnId = event.rawJson?.params?.turn?.id;
  if (!turnId) return;
  const turn = getTurn(thread, turnId);
  applyTurnMeta(turn, event);
}

function applyTurnMeta(turn, event) {
  const raw = event.rawJson;
  const params = raw?.params;
  const method = raw?.method;
  const ts = event.ts_ms || 0;
  turn.firstTs = turn.firstTs ? Math.min(turn.firstTs, ts) : ts;
  const lifecycle = params?.turn;
  if (method === "turn/started" && lifecycle) {
    turn.status = lifecycle.status || turn.status;
    turn.startedAt = lifecycle.startedAt ?? turn.startedAt;
    turn.completedAt = lifecycle.completedAt ?? turn.completedAt;
    turn.startedTs = ts || turn.startedTs;
    turn.startedSeq = event.seq ?? turn.startedSeq;
    turn.durationMs = lifecycle.durationMs ?? turn.durationMs;
    turn.error = lifecycle.error ?? turn.error;
  }
  if (method === "turn/completed" && lifecycle) {
    turn.status = lifecycle.status || turn.status;
    turn.startedAt = lifecycle.startedAt ?? turn.startedAt;
    turn.completedAt = lifecycle.completedAt ?? turn.completedAt;
    turn.completedTs = ts || turn.completedTs;
    turn.completedSeq = event.seq ?? turn.completedSeq;
    turn.durationMs = lifecycle.durationMs ?? turn.durationMs;
    turn.error = lifecycle.error ?? turn.error;
  }
}

function applyTokenUsageToTurn(thread, event) {
  const params = event.rawJson?.params || {};
  const usage = params.tokenUsage;
  const turnId = event.turnId || params.turnId;
  if (!usage || !turnId) return;
  const ts = Number(event.ts_ms) || 0;
  const nextTokenUsage = normalizeConversationTokenUsage(usage, ts);
  if (!thread.turnsById.has(turnId)) {
    const pending = thread.pendingTokenUsageByTurnId?.get(turnId);
    if (!pending || !ts || pending.ts <= ts) {
      thread.pendingTokenUsageByTurnId?.set(turnId, nextTokenUsage);
    }
    return;
  }
  const turn = thread.turnsById.get(turnId);
  if (turn.tokenUsage && ts && turn.tokenUsage.ts > ts) return;
  turn.tokenUsage = nextTokenUsage;
}

function isTokenUsageEvent(event) {
  return event.method === "thread/tokenUsage/updated" || event.rawJson?.method === "thread/tokenUsage/updated";
}

function normalizeConversationTokenUsage(usage, ts = 0) {
  return {
    ts,
    total: normalizeTokenUsageTotals(usage?.total),
    last: normalizeTokenUsageTotals(usage?.last),
    modelContextWindow: Number(usage?.modelContextWindow) || 0,
  };
}

function normalizeTokenUsageTotals(value = {}) {
  return {
    totalTokens: Number(value.totalTokens) || 0,
    inputTokens: Number(value.inputTokens) || 0,
    cachedInputTokens: Number(value.cachedInputTokens) || 0,
    outputTokens: Number(value.outputTokens) || 0,
    reasoningOutputTokens: Number(value.reasoningOutputTokens) || 0,
  };
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
        countsAsBlock: true,
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
        countsAsBlock: true,
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
        countsAsBlock: true,
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
        countsAsBlock: true,
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
        countsAsBlock: true,
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
        countsAsBlock: true,
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
    countsAsBlock: method === "item/started",
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
        text: method === "item/agentMessage/delta" ? params.delta || "" : item.text || "",
        appendText: method === "item/agentMessage/delta",
        preview: (item.text || params.delta || "assistant").slice(0, 140),
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
        output: method === "item/commandExecution/outputDelta" ? params.delta || "" : item.aggregatedOutput || "",
        appendOutput: method === "item/commandExecution/outputDelta",
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
  if (item.type === "webSearch") {
    const detail = webSearchDetail(item);
    return {
      turnId,
      block: {
        ...base,
        kind: "webSearch",
        role: "tool",
        label: "webSearch",
        meta: webSearchActionType(item.action) || item.status || "webSearch",
        query: item.query,
        action: item.action,
        text: detail,
        preview: webSearchPreview(item, detail),
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
        label: "context compact",
        meta: "contextCompaction",
        text: "Conversation context was compacted.",
        preview: "Context compacted",
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

function applyBlock(turn, update, event) {
  const resolution = resolveContinuousSegment(turn, update, event);
  let block = resolution.block;
  if (resolution.isNew) {
    block = {
      ...update,
      key: resolution.segmentKey,
      aggregateKey: resolution.aggregateKey,
      events: [],
      firstSeq: event.seq ?? event.viewId,
      lastSeq: event.seq ?? event.viewId,
      firstTs: event.ts_ms || 0,
      lastTs: event.ts_ms || 0,
      text: "",
      output: "",
    };
    turn.blocksByKey.set(block.key, block);
    turn.blocks.push(block);
  }
  block.events.push(event);
  block.lastSeq = event.seq ?? event.viewId ?? block.lastSeq;
  block.lastTs = event.ts_ms || block.lastTs;
  block.meta = update.meta || block.meta;
  block.status = update.status ?? block.status;
  block.exitCode = update.exitCode ?? block.exitCode;
  block.durationMs = update.durationMs ?? block.durationMs;
  for (const field of ["label", "role", "kind", "command", "cwd", "server", "tool", "argumentsText", "resultText", "error", "changes", "plan", "diff", "revisedPrompt", "savedPath", "itemType", "query", "action"]) {
    if (update[field] != null && update[field] !== "") block[field] = update[field];
  }
  if (update.appendText) {
    block.text = appendBlockValue(block.text, update.text);
  } else if (update.text != null && update.text !== "") {
    block.text = boundedBlockValue(update.text);
  }
  if (update.appendOutput) {
    block.output = appendBlockValue(block.output, update.output);
  } else if (update.output != null && update.output !== "") {
    block.output = boundedBlockValue(update.output);
  }
  if (update.preview) block.preview = update.preview;
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

function reasoningText(item) {
  const summary = Array.isArray(item.summary) ? item.summary.map((part) => part.text || part).join("\n") : "";
  const content = Array.isArray(item.content) ? item.content.map((part) => part.text || part).join("\n") : "";
  return [summary, content].filter(Boolean).join("\n\n");
}

function webSearchActionType(action) {
  return typeof action?.type === "string" ? action.type : "";
}

function webSearchDetail(item) {
  const action = item?.action || {};
  const actionType = webSearchActionType(action) || "webSearch";
  const lines = [actionType];
  if (item?.query) lines.push(`query: ${item.query}`);
  if (action.query && action.query !== item?.query) lines.push(`action query: ${action.query}`);
  if (Array.isArray(action.queries) && action.queries.length) {
    lines.push("queries:");
    for (const query of action.queries) lines.push(`- ${query}`);
  }
  if (action.url) lines.push(`url: ${action.url}`);
  if (action.pattern) lines.push(`pattern: ${action.pattern}`);
  return lines.join("\n");
}

function webSearchPreview(item, detail) {
  const action = item?.action || {};
  return action.url || action.query || item?.query || detail || "webSearch";
}

function webSearchBlockDetail(block) {
  return webSearchDetail({ query: block?.query, action: block?.action });
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

function renderTimeline() {
  const limit = Number(els.limitInput.value || "1000");
  const filtered = state.events.filter(passesFilters).slice(-limit);
  els.countLine.textContent = `${filtered.length} shown / ${state.events.length} buffered`;
  els.liveLine.textContent = state.paused ? "paused" : "live";
  els.eventList.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const event of filtered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `eventRow dir-${event.dir || "unknown"}`;
    if (event.viewId === state.selectedViewId) row.classList.add("selected");
    row.dataset.viewId = event.viewId;
    row.innerHTML = `
      <span class="seq">#${event.seq ?? "-"}</span>
      <span class="time">${eventTime(event)}</span>
      <span class="source">${escapeHtml(sourceLabel(event.source))}</span>
      <span class="dir">${event.dir || ""}</span>
      <span class="method">${escapeHtml(methodLabel(event))}</span>
      <span class="item" title="${escapeHtml(eventItemLabel(event))}">${escapeHtml(eventItemLabel(event))}</span>
      <span class="ids">${escapeHtml([shortId(event.sessionId), shortId(event.threadId), shortId(event.turnId), shortId(event.itemId)].filter(Boolean).join(" / "))}</span>
      <span class="summary">${escapeHtml(truncateInline(event.summary || "", maxTimelineSummaryChars))}</span>
    `;
    row.addEventListener("click", () => selectEvent(event.viewId));
    fragment.appendChild(row);
  }
  els.eventList.appendChild(fragment);
}

function selectEvent(viewId) {
  state.selectedViewId = viewId;
  const event = state.events.find((item) => item.viewId === viewId);
  if (event) {
    const { viewId: _viewId, ...displayEvent } = event;
    els.detailPre.textContent = JSON.stringify(displayEvent, null, 2);
  } else {
    els.detailPre.textContent = "Select an event.";
  }
  els.detailPanel.classList.toggle("open", Boolean(event));
  els.detailBackdrop.classList.toggle("open", Boolean(event));
  render();
}

function closeDetail() {
  state.selectedViewId = null;
  els.detailPre.textContent = "Select an event.";
  els.detailPanel.classList.remove("open");
  els.detailBackdrop.classList.remove("open");
  render();
}

function updateStatus(status) {
  state.status = status;
  const sourceState = status?.preloadNdjson ? (status?.fileMissing ? "file-missing" : "ok") : "live-only";
  const storage = status?.storage;
  const storageLabel = storage?.enabled
    ? `storage pending ${formatBytes(storage.pendingBytes || 0)}${storage.droppedEvents ? ` dropped ${storage.droppedEvents}` : ""}`
    : "storage off";
  els.statusLine.textContent = `${sourceState} | seq ${status?.lastSeq ?? 0} | buffered ${status?.bufferedEvents ?? 0} | ingested ${status?.totalIngested ?? 0} | restored ${status?.totalRestored ?? 0} | ${storageLabel} | http ${status?.clients ?? 0} | ingest ${status?.ingestClients ?? 0} | ${status?.ingest ?? ""}`;
  scheduleStorageRefresh(false);
  scheduleTokenUsageRefresh(false);
}

function addEvent(event) {
  if (state.paused) return;
  state.events.push(ingestEvent(event));
  const max = Math.max(5000, Number(els.limitInput.value || "1000") * 2);
  if (state.events.length > max) {
    state.events.splice(0, state.events.length - max);
  }
  if (state.activeTab === "timeline") scheduleRender();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncateInline(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

async function loadInitial() {
  const limit = Math.max(5000, Number(els.limitInput.value || "1000"));
  const [eventsRes] = await Promise.all([fetch(`/api/events?limit=${encodeURIComponent(limit)}&compact=1`), refreshConversationModel({ hydrate: false }), refreshStorage(true)]);
  state.nextViewId = 1;
  state.events = (await eventsRes.json()).map(ingestEvent);
  render();
}

async function refreshStorage(force = false) {
  try {
    const res = await fetch(`/api/storage${force ? "?force=1" : ""}`);
    if (!res.ok) return;
    state.storage = await res.json();
    renderStorage();
  } catch {
    state.storage = state.storage || null;
  }
}

async function refreshTokenUsage(force = false) {
  try {
    const res = await fetch(`/api/token-usage${force ? "?force=1" : ""}`);
    if (!res.ok) return;
    state.tokenUsage = await res.json();
    renderTokens();
  } catch {
    state.tokenUsage = state.tokenUsage || null;
  }
}

function scheduleTokenUsageRefresh(force = false) {
  if (force) {
    void refreshTokenUsage(true);
    return;
  }
  if (state.activeTab !== "tokens") return;
  if (state.tokenUsageRefreshScheduled) return;
  state.tokenUsageRefreshScheduled = true;
  setTimeout(async () => {
    state.tokenUsageRefreshScheduled = false;
    await refreshTokenUsage(false);
  }, 30000);
}

function scheduleStorageRefresh(force = false) {
  if (force) {
    void refreshStorage(true);
    return;
  }
  if (state.storageRefreshScheduled) return;
  state.storageRefreshScheduled = true;
  setTimeout(async () => {
    state.storageRefreshScheduled = false;
    await refreshStorage(false);
  }, 30000);
}

async function cleanupStorage() {
  const keepDays = Number(els.storageKeepDaysInput.value || "0");
  const targetMb = Number(els.storageTargetMbInput.value || "0");
  const targetBytes = targetMb > 0 ? Math.floor(targetMb * 1024 * 1024) : null;
  const payload = {
    keepDays: Number.isFinite(keepDays) ? keepDays : null,
    targetBytes,
    dryRun: true,
  };
  els.cleanupStorageBtn.disabled = true;
  try {
    const previewRes = await fetch("/api/storage/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const preview = await previewRes.json();
    if (!previewRes.ok) throw new Error(preview.error || "cleanup preview failed");
    if (!preview.deletedSegments) {
      els.storageDetail.textContent = "No matching old storage segments.";
      return;
    }
    const confirmed = window.confirm(`Delete ${preview.deletedSegments} segments (${formatBytes(preview.deletedBytes)})?`);
    if (!confirmed) return;
    const cleanupRes = await fetch("/api/storage/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, dryRun: false }),
    });
    const cleanup = await cleanupRes.json();
    if (!cleanupRes.ok) throw new Error(cleanup.error || "cleanup failed");
    els.storageDetail.textContent = `Deleted ${cleanup.deletedSegments} segments (${formatBytes(cleanup.deletedBytes)}).`;
    await refreshStorage(true);
  } catch (error) {
    els.storageDetail.textContent = `Cleanup failed: ${error.message}`;
  } finally {
    els.cleanupStorageBtn.disabled = false;
  }
}

function conversationThreadsById(model) {
  const threads = new Map();
  for (const session of model?.sessions || []) {
    for (const thread of sessionThreads(session)) threads.set(thread.id, thread);
  }
  return threads;
}

function threadSummaryMatchesDetail(summary, detail) {
  return Boolean(
    detail?.detailLoaded &&
    Number(summary?.version || 0) === Number(detail.version || 0) &&
    Number(summary?.lastTs || 0) === Number(detail.lastTs || 0) &&
    Number(summary?.events || 0) === Number(detail.events || 0) &&
    Number(summary?.blocks || 0) === Number(detail.blocks || 0) &&
    Number(summary?.turnCount || summary?.turns?.length || 0) === Number(detail.turnCount || detail.turns?.length || 0)
  );
}

function mergeConversationSummary(nextModel) {
  const previousThreads = conversationThreadsById(state.conversationModel);
  for (const session of nextModel?.sessions || []) {
    session.threads = sessionThreads(session).map((summaryThread) => {
      const detail = previousThreads.get(summaryThread.id);
      if (!threadSummaryMatchesDetail(summaryThread, detail)) return summaryThread;
      return { ...summaryThread, turns: detail.turns, detailLoaded: true };
    });
  }
  return nextModel;
}

function replaceConversationThread(response) {
  const detail = response?.thread;
  if (!detail || !state.conversationModel?.sessions) return false;
  for (const session of state.conversationModel.sessions) {
    const index = sessionThreads(session).findIndex((thread) => thread.id === detail.id);
    if (index < 0) continue;
    const current = session.threads[index];
    if (Number(current?.lastTs || 0) > Number(detail.lastTs || 0)) return false;
    session.threads[index] = { ...detail, detailLoaded: true };
    state.conversationModel.version = Math.max(Number(state.conversationModel.version || 0), Number(response.version || 0));
    return true;
  }
  return false;
}

function requestConversationThread(threadId) {
  if (!threadId) return Promise.resolve(null);
  const existing = threadDetailRequests.get(threadId);
  if (existing) return existing;
  conversationPerf.threadRequests += 1;
  publishConversationPerf();
  const request = fetch(`/api/conversations/thread?threadId=${encodeURIComponent(threadId)}`)
    .then(async (res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .finally(() => threadDetailRequests.delete(threadId));
  threadDetailRequests.set(threadId, request);
  return request;
}

async function ensureConversationThreadDetail(threadId) {
  const current = conversationThreadsById(state.conversationModel).get(threadId);
  if (!current || current.detailLoaded !== false) return Boolean(current);
  const preserveConversation = state.activeTab === "conversation" && Boolean(els.conversationMessages.querySelector(".segmentCard, .turnDivider, .threadDivider"));
  const response = await requestConversationThread(threadId);
  if (!replaceConversationThread(response)) return false;
  state.conversationViewSignature = "";
  renderSessionsAndConversation({ preserveConversation, autoUpdate: preserveConversation });
  if (!preserveConversation && state.selectedThreadId === threadId && state.selectedTurnId) {
    requestAnimationFrame(() => scrollToTurnLifecycle(threadId, state.selectedTurnId));
  }
  return true;
}

async function refreshConversationModel(options = {}) {
  const perfStartedAt = performance.now();
  conversationPerf.modelRequests += 1;
  conversationPerf.modelActive += 1;
  conversationPerf.modelMaxActive = Math.max(conversationPerf.modelMaxActive, conversationPerf.modelActive);
  publishConversationPerf();
  try {
    const wantsSummary = !hasActiveConversationFilters();
    const sameMode = Boolean(state.conversationModel?.summary) === wantsSummary;
    const version = Number(state.conversationModel?.version);
    const query = sameMode && Number.isFinite(version) ? `?version=${encodeURIComponent(version)}` : "";
    const endpoint = wantsSummary ? "/api/conversations/summary" : "/api/conversations";
    conversationPerf.lastEndpoint = endpoint;
    const res = await fetch(`${endpoint}${query}`);
    if (!res.ok) return false;
    let nextModel = await res.json();
    conversationPerf.lastBytes = Number(res.headers.get("x-response-bytes") || 0);
    if (debugPerf) {
      console.debug("[trace-viewer] refreshConversationModel", {
        endpoint,
        ms: Math.round((performance.now() - perfStartedAt) * 10) / 10,
        bytes: conversationPerf.lastBytes,
        kind: res.headers.get("x-trace-response-kind") || "",
        serverTiming: res.headers.get("server-timing") || "",
      });
    }
    if (nextModel.unchanged) {
      conversationPerf.unchangedResponses += 1;
      return false;
    }
    if (nextModel.summary) nextModel = mergeConversationSummary(nextModel);
    state.conversationModel = nextModel;
    if (options.hydrate !== false && nextModel.summary) {
      if (!state.selectedSessionId || !nextModel.sessions.some((session) => session.id === state.selectedSessionId)) {
        state.selectedSessionId = nextModel.sessions[0]?.id || "";
        state.selectedThreadId = "";
      }
      const selectedSession = nextModel.sessions.find((session) => session.id === state.selectedSessionId);
      const selectedThread = selectedSession ? ensureSelectedThread(selectedSession) : null;
      if (selectedThread?.detailLoaded === false) {
        const response = await requestConversationThread(selectedThread.id);
        replaceConversationThread(response);
      }
    }
    return true;
  } catch {
    state.conversationModel = state.conversationModel || null;
    return false;
  } finally {
    conversationPerf.modelActive -= 1;
    conversationPerf.lastDurationMs = Math.round((performance.now() - perfStartedAt) * 10) / 10;
    publishConversationPerf();
  }
}

function conversationRefreshDelay() {
  return document.hidden ? conversationRefreshHiddenMs : conversationRefreshVisibleMs;
}

async function runConversationRefresh() {
  state.conversationRefreshScheduled = false;
  state.conversationRefreshTimer = null;
  if (state.conversationRefreshInFlight || !state.conversationRefreshDirty) return;
  state.conversationRefreshInFlight = true;
  state.conversationRefreshDirty = false;
  try {
    const changed = await refreshConversationModel();
    if (changed && !state.paused) {
      if (state.activeTab === "conversation") {
        renderStorage();
        renderSessionsAndConversation({ preserveConversation: true, autoUpdate: true });
      } else {
        scheduleRender();
      }
    }
  } finally {
    state.conversationRefreshInFlight = false;
    if (state.conversationRefreshDirty && !state.paused) scheduleConversationRefresh();
  }
}

function scheduleConversationRefresh(options = {}) {
  state.conversationRefreshDirty = true;
  if (state.conversationRefreshInFlight || state.conversationRefreshScheduled) return;
  state.conversationRefreshScheduled = true;
  state.conversationRefreshTimer = setTimeout(() => {
    void runConversationRefresh();
  }, options.immediate ? 0 : conversationRefreshDelay());
}

function connectSse() {
  const source = new EventSource("/events?compact=1");
  source.addEventListener("event", (message) => {
    addEvent(JSON.parse(message.data));
    if (!state.paused) scheduleConversationRefresh();
  });
  source.addEventListener("status", (message) => {
    updateStatus(JSON.parse(message.data));
  });
  source.onerror = () => {
    els.statusLine.textContent = "SSE disconnected; retrying...";
  };
}

document.addEventListener("visibilitychange", () => {
  if (!state.conversationRefreshDirty || state.conversationRefreshInFlight) return;
  if (state.conversationRefreshTimer) clearTimeout(state.conversationRefreshTimer);
  state.conversationRefreshTimer = null;
  state.conversationRefreshScheduled = false;
  scheduleConversationRefresh({ immediate: !document.hidden });
});

for (const el of [els.dirFilter, els.methodFilter, els.threadFilter, els.textFilter, els.limitInput]) {
  el.addEventListener("input", () => {
    state.conversationViewSignature = "";
    render();
    scheduleConversationRefresh({ immediate: true });
  });
}

els.conversationMessages.addEventListener("scroll", () => {
  if (state.conversationScrollApplying) return;
  updateConversationFollowState();
  drawAggregateLinks();
});
els.aggregateRail.addEventListener("scroll", drawAggregateLinks);
els.segmentRail.addEventListener("scroll", drawAggregateLinks);
window.addEventListener("resize", drawAggregateLinks);

els.followLatestBtn?.addEventListener("click", () => {
  const token = beginConversationScrollApplication();
  scrollToLatestConversationEdge();
  state.conversationFollowLatest = true;
  state.conversationUnreadUpdates = 0;
  conversationObservedAnchor = null;
  finishConversationScrollApplication(token);
  updateFollowLatestButton();
});

els.conversationTabBtn.addEventListener("click", () => {
  state.activeTab = "conversation";
  state.conversationViewSignature = "";
  render();
});

els.tokensTabBtn.addEventListener("click", () => {
  state.activeTab = "tokens";
  render();
  void refreshTokenUsage(!state.tokenUsage);
});

els.timelineTabBtn.addEventListener("click", () => {
  state.activeTab = "timeline";
  render();
});

els.pauseBtn.addEventListener("click", () => {
  state.paused = !state.paused;
  els.pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  if (state.paused && state.conversationRefreshTimer) {
    clearTimeout(state.conversationRefreshTimer);
    state.conversationRefreshTimer = null;
    state.conversationRefreshScheduled = false;
    state.conversationRefreshDirty = false;
  }
  render();
  if (!state.paused) scheduleConversationRefresh({ immediate: true });
});

els.clearBtn.addEventListener("click", () => {
  state.events = [];
  state.conversationModel = { version: 0, sessions: [] };
  state.selectedSessionId = "";
  state.expandedSessionId = "";
  state.selectedThreadId = "";
  state.selectedTurnId = "";
  state.selectedSegmentKey = "";
  state.selectedAggregateKey = "";
  state.conversationViewSignature = "";
  closeDetail();
});

els.refreshStorageBtn.addEventListener("click", () => {
  void refreshStorage(true);
});
els.refreshTokensBtn.addEventListener("click", () => {
  void refreshTokenUsage(true);
});
els.cleanupStorageBtn.addEventListener("click", () => {
  void cleanupStorage();
});
for (const table of [els.tokenThreadsTable, els.tokenTurnsTable]) {
  table.addEventListener("click", (event) => {
    const row = event.target.closest(".tokenDataRow");
    if (!row) return;
    const threadId = row.dataset.threadId || "";
    const turnId = row.dataset.turnId || "";
    const match = findSessionForThreadTurn(threadId, turnId);
    if (!match) return;
    state.activeTab = "conversation";
    state.selectedSessionId = match.session.id;
    state.expandedSessionId = match.session.id;
    state.selectedThreadId = match.thread.id;
    state.selectedTurnId = turnId;
    state.selectedSegmentKey = "";
    state.selectedAggregateKey = "";
    state.conversationViewSignature = "";
    render();
    requestAnimationFrame(() => {
      if (turnId) {
        scrollToTurnLifecycle(match.thread.id, turnId);
      } else {
        jumpToConversationElement(document.querySelector(`#thread-${cssSafeId(match.thread.id)}`), "start");
      }
    });
  });
}
els.closeDetailBtn.addEventListener("click", closeDetail);
els.turnSortBtn.addEventListener("click", () => {
  state.turnSortDescending = !state.turnSortDescending;
  state.conversationViewSignature = "";
  render();
});
els.closeSegmentDetailBtn.addEventListener("click", () => {
  state.selectedSegmentKey = "";
  renderSegmentsActiveState();
  renderSegmentDetail(null);
});
els.segmentRecoveredBtn.addEventListener("click", () => {
  if (!segmentRawSelection?.block?.outputEncoding) return;
  segmentContentMode = "recovered";
  renderSegmentDetail(segmentRawSelection);
});
els.segmentOriginalBtn.addEventListener("click", () => {
  if (!segmentRawSelection) return;
  segmentContentMode = "original";
  renderSegmentDetail(segmentRawSelection);
});
els.openSegmentRawBtn.addEventListener("click", openSegmentRaw);
els.closeSegmentRawBtn.addEventListener("click", closeSegmentRaw);
els.segmentRawBackdrop.addEventListener("click", closeSegmentRaw);
els.segmentOriginalTab.addEventListener("click", () => setSegmentRawTab("original"));
els.segmentProcessedTab.addEventListener("click", () => setSegmentRawTab("processed"));
els.closeTurnOverlayBtn.addEventListener("click", closeTurnOverlay);
els.detailBackdrop.addEventListener("click", closeDetail);
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (els.segmentRawModal.classList.contains("open")) {
    closeSegmentRaw();
    return;
  }
  if (els.detailPanel.classList.contains("open")) {
    closeDetail();
    return;
  }
  if (els.turnOverlay.classList.contains("open")) closeTurnOverlay();
});

initSplitters();
await loadInitial();
connectSse();
