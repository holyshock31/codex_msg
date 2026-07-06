const state = {
  events: [],
  nextViewId: 1,
  selectedViewId: null,
  selectedSessionId: "",
  expandedSessionId: "",
  selectedTurnId: "",
  selectedSegmentKey: "",
  activeTab: "conversation",
  paused: false,
  status: null,
  conversationModel: null,
  conversationRefreshScheduled: false,
  renderScheduled: false,
};

const maxDisplayedBlockChars = 16000;
const maxStoredBlockChars = 32000;
const maxTimelineSummaryChars = 600;

const els = {
  statusLine: document.querySelector("#statusLine"),
  conversationTabBtn: document.querySelector("#conversationTabBtn"),
  timelineTabBtn: document.querySelector("#timelineTabBtn"),
  pauseBtn: document.querySelector("#pauseBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  dirFilter: document.querySelector("#dirFilter"),
  methodFilter: document.querySelector("#methodFilter"),
  threadFilter: document.querySelector("#threadFilter"),
  textFilter: document.querySelector("#textFilter"),
  limitInput: document.querySelector("#limitInput"),
  conversationView: document.querySelector("#conversationView"),
  timelineView: document.querySelector("#timelineView"),
  sessionList: document.querySelector("#sessionList"),
  sessionCountLine: document.querySelector("#sessionCountLine"),
  turnOverlay: document.querySelector("#turnOverlay"),
  turnOverlayTitle: document.querySelector("#turnOverlayTitle"),
  turnOverlayMeta: document.querySelector("#turnOverlayMeta"),
  turnOverlayList: document.querySelector("#turnOverlayList"),
  closeTurnOverlayBtn: document.querySelector("#closeTurnOverlayBtn"),
  conversationTitle: document.querySelector("#conversationTitle"),
  conversationMeta: document.querySelector("#conversationMeta"),
  conversationMessages: document.querySelector("#conversationMessages"),
  segmentDetail: document.querySelector("#segmentDetail"),
  segmentDetailTitle: document.querySelector("#segmentDetailTitle"),
  segmentDetailMeta: document.querySelector("#segmentDetailMeta"),
  segmentContentPre: document.querySelector("#segmentContentPre"),
  openSegmentRawBtn: document.querySelector("#openSegmentRawBtn"),
  segmentRawModal: document.querySelector("#segmentRawModal"),
  segmentRawBackdrop: document.querySelector("#segmentRawBackdrop"),
  segmentRawMeta: document.querySelector("#segmentRawMeta"),
  segmentRawPre: document.querySelector("#segmentRawPre"),
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

function durationLabel(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

function passesFilters(event) {
  const dir = els.dirFilter.value;
  const method = els.methodFilter.value.trim().toLowerCase();
  const thread = els.threadFilter.value.trim().toLowerCase();
  const text = els.textFilter.value.trim().toLowerCase();
  if (dir && event.dir !== dir) return false;
  if (method && !String(event.method || "").toLowerCase().includes(method)) return false;
  if (thread && !eventMatchesThreadFilter(event, thread)) return false;
  if (text) {
    const haystack = `${event.summary || ""}\n${event.raw || ""}\n${event.itemId || ""}\n${event.turnId || ""}`.toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  return true;
}

function eventMatchesThreadFilter(event, needle) {
  if (String(event.threadId || "").toLowerCase().includes(needle)) return true;
  const raw = event.rawJson;
  const params = raw?.params || {};
  const data = raw?.result?.data;
  if (String(params.threadId || params.thread_id || params.parentThreadId || "").toLowerCase().includes(needle)) return true;
  if (Array.isArray(data)) {
    return data.some((item) => {
      const haystack = `${item?.id || ""}\n${item?.threadId || ""}\n${item?.thread_id || ""}\n${item?.name || ""}\n${item?.title || ""}\n${item?.preview || ""}\n${item?.cwd || ""}`.toLowerCase();
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
  els.conversationView.classList.toggle("hidden", !conversation);
  els.timelineView.classList.toggle("hidden", conversation);
  els.conversationTabBtn.classList.toggle("active", conversation);
  els.timelineTabBtn.classList.toggle("active", !conversation);
  els.liveLine.textContent = state.paused ? "paused" : "live";
}

function renderSessionsAndConversation() {
  const model = filteredConversationModel() || buildConversationModel(state.events.filter(passesFilters), state.events);
  if (!state.selectedSessionId || !model.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = model.sessions[0]?.id || "";
    state.expandedSessionId = "";
    state.selectedTurnId = "";
    state.selectedSegmentKey = "";
  }
  if (state.expandedSessionId && !model.sessions.some((session) => session.id === state.expandedSessionId)) {
    state.expandedSessionId = "";
  }
  renderSessionList(model.sessions);
  const selected = model.sessions.find((session) => session.id === state.selectedSessionId);
  const expanded = model.sessions.find((session) => session.id === state.expandedSessionId);
  renderTurnOverlay(expanded);
  renderConversation(selected);
}

function filteredConversationModel() {
  if (!state.conversationModel?.sessions) return null;
  const sessions = [];
  for (const session of state.conversationModel.sessions) {
    const filteredTurns = [];
    let events = 0;
    let blocks = 0;
    let preview = "";
    for (const turn of session.turns || []) {
      const visibleBlocks = (turn.blocks || []).filter((block) => !isLifecycleOnlyBlock(block));
      const filteredBlocks = visibleBlocks.filter((block) => blockMatchesFilters(block, session, turn));
      if (!filteredBlocks.length) continue;
      filteredTurns.push({ ...turn, blocks: filteredBlocks });
      blocks += filteredBlocks.length;
      events += filteredBlocks.reduce((sum, block) => sum + (block.eventCount || block.events?.length || 0), 0);
      if (!preview) preview = filteredBlocks.find((block) => block.preview)?.preview || "";
    }
    if (!filteredTurns.length && hasActiveConversationFilters()) continue;
    sessions.push({
      ...session,
      turns: filteredTurns,
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

function blockMatchesFilters(block, session, turn) {
  const dir = els.dirFilter.value;
  const method = els.methodFilter.value.trim().toLowerCase();
  const thread = els.threadFilter.value.trim().toLowerCase();
  const text = els.textFilter.value.trim().toLowerCase();
  if (dir && !(block.events || []).some((event) => event.dir === dir)) return false;
  if (method) {
    const methods = `${block.meta || ""}\n${(block.events || []).map((event) => event.method || "").join("\n")}`.toLowerCase();
    if (!methods.includes(method)) return false;
  }
  if (thread) {
    const threadHaystack = `${session.id || ""}\n${session.title || ""}\n${session.threadPreview || ""}\n${session.cwd || ""}\n${turn.id || ""}`.toLowerCase();
    if (!threadHaystack.includes(thread)) return false;
  }
  if (text) {
    const haystack = `${block.preview || ""}\n${blockText(block)}\n${block.itemId || ""}\n${turn.id || ""}\n${session.id || ""}`.toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  return true;
}

function renderSessionList(sessions) {
  els.sessionCountLine.textContent = `${sessions.length}`;
  els.sessionList.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "sessionItem";
    if (session.id === state.selectedSessionId) item.classList.add("selected");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sessionRow";
    if (session.id === state.selectedSessionId) button.classList.add("selected");
    button.title = `${sessionTitle(session)}\n${session.id}`;
    button.innerHTML = `
      <span class="sessionName">${escapeHtml(sessionTitle(session))}</span>
      <span class="sessionId">${escapeHtml(sourceLabel(session.source))} / ${escapeHtml(shortId(session.id))}</span>
      <span class="sessionStats">${session.turns.length} turns / ${session.blocks} blocks / ${session.events} events</span>
      <span class="sessionPreview">${escapeHtml(session.preview || "")}</span>
    `;
    button.addEventListener("click", () => {
      const switchingSession = state.selectedSessionId !== session.id;
      state.selectedSessionId = session.id;
      state.expandedSessionId = session.id;
      if (switchingSession) {
        state.selectedTurnId = "";
        state.selectedSegmentKey = "";
      }
      render();
    });
    item.appendChild(button);
    fragment.appendChild(item);
  }
  els.sessionList.appendChild(fragment);
}

function renderTurnOverlay(session) {
  const open = Boolean(session && state.expandedSessionId === session.id);
  els.turnOverlay.classList.toggle("open", open);
  els.turnOverlay.setAttribute("aria-hidden", String(!open));
  els.turnOverlayTitle.textContent = open ? sessionTitle(session) : "Turns";
  els.turnOverlayMeta.textContent = open
    ? `${session.turns.length} turns / ${session.blocks} blocks / ${session.events} events`
    : "Select a session to inspect turns.";
  els.turnOverlayList.innerHTML = "";
  if (!open) return;

  if (!session.turns.length) {
    const empty = document.createElement("div");
    empty.className = "turnOverlayEmpty";
    empty.textContent = "No turns in the current filters.";
    els.turnOverlayList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  session.turns.forEach((turn, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sessionTurnRow";
    if (turn.id === state.selectedTurnId) button.classList.add("active");
    button.title = `Turn ${index + 1} / ${shortId(turn.id)} / ${turn.blocks.length} segments`;
    button.dataset.turnId = turn.id;
    button.innerHTML = `
      <span class="turnRailIndex">${index + 1}</span>
      <span class="turnRailText">${escapeHtml(turnLabel(turn, index))}</span>
      <span class="turnRailCount">${turn.blocks.length}</span>
    `;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      selectTurn(turn.id);
    });
    fragment.appendChild(button);
  });
  els.turnOverlayList.appendChild(fragment);
}

function closeTurnOverlay() {
  state.expandedSessionId = "";
  render();
}

function renderConversation(session) {
  if (!session) {
    els.conversationTitle.textContent = "No session selected";
    els.conversationMeta.textContent = "Select a session to inspect turns.";
    els.conversationMessages.innerHTML = `<div class="emptyState">No conversation events in the current filters.</div>`;
    renderSegmentDetail(null);
    return;
  }

  if (state.selectedTurnId && !session.turns.some((turn) => turn.id === state.selectedTurnId)) {
    state.selectedTurnId = "";
    state.selectedSegmentKey = "";
  }

  els.conversationTitle.textContent = sessionTitle(session);
  els.conversationMeta.textContent = [sourceLabel(session.source), session.id, session.cwd, `${session.turns.length} turns`, `${session.blocks} blocks`].filter(Boolean).join(" / ");

  const turns = session.turns;
  els.conversationMessages.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const turn of turns) {
    fragment.appendChild(turnDivider(turn));
    for (const block of turn.blocks) {
      fragment.appendChild(segmentCard(block, turn));
    }
  }
  if (!fragment.childNodes.length) {
    els.conversationMessages.innerHTML = `<div class="emptyState">No blocks in this turn.</div>`;
  } else {
    els.conversationMessages.appendChild(fragment);
  }
  renderSegmentDetail(findSelectedSegment(session));
}

function turnDivider(turn) {
  const el = document.createElement("div");
  el.className = "turnDivider";
  if (turn.id === state.selectedTurnId) el.classList.add("active");
  el.id = `turn-${cssSafeId(turn.id)}`;
  el.dataset.turnId = turn.id;
  const status = turn.status ? ` / ${turn.status}` : "";
  const duration = turn.durationMs != null ? ` / ${durationLabel(turn.durationMs)}` : "";
  el.innerHTML = `
    <span>Turn ${escapeHtml(shortId(turn.id))}${status}${duration}</span>
  `;
  return el;
}

function turnLabel(turn, index) {
  const user = turn.blocks.find((block) => block.role === "user");
  if (user) return userFacingUserText(blockText(user)) || user.preview || user.label || `Turn ${index + 1}`;
  const first = turn.blocks.find((block) => block.preview || block.label);
  return displayPreview(first) || first?.label || `Turn ${index + 1}`;
}

function selectTurn(turnId) {
  state.selectedTurnId = turnId;
  state.selectedSegmentKey = "";
  for (const divider of document.querySelectorAll(".turnDivider.active")) {
    divider.classList.remove("active");
  }
  const target = document.querySelector(`#turn-${cssSafeId(turnId)}`);
  target?.classList.add("active");
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
  renderSegmentsActiveState();
  renderSegmentDetail(null);
}

function cssSafeId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value || ""));
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function segmentCard(block, turn) {
  const article = document.createElement("article");
  article.className = `messageBlock segmentCard role-${block.role}`;
  if (block.key === state.selectedSegmentKey) article.classList.add("selected");
  article.id = `segment-${cssSafeId(block.key)}`;
  article.tabIndex = 0;
  article.dataset.segmentKey = block.key;
  const body = blockText(block);
  const preview = segmentPreview(block, body);
  article.innerHTML = `
    <div class="messageMeta">
      <span class="roleBadge">${escapeHtml(block.label)}</span>
      <span>${escapeHtml(block.meta)}</span>
      <span>${escapeHtml(eventTime(block.events[0] || {}))}</span>
      <span>${block.events.length} events</span>
    </div>
    <div class="segmentPreview">${escapeHtml(preview)}</div>
  `;
  article.addEventListener("click", () => selectSegment(block, turn));
  article.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectSegment(block, turn);
    }
  });
  return article;
}

function segmentPreview(block, body) {
  const text = String(body || block.preview || block.label || "(empty)").replace(/\s+/g, " ").trim();
  return truncateInline(text || "(empty)", 360);
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

function selectSegment(block, turn) {
  state.selectedTurnId = turn.id;
  state.selectedSegmentKey = block.key;
  renderSegmentsActiveState();
  renderSegmentDetail({ block, turn });
}

function renderSegmentsActiveState() {
  for (const card of document.querySelectorAll(".segmentCard.selected")) {
    card.classList.remove("selected");
  }
  if (state.selectedSegmentKey) {
    document.querySelector(`#segment-${cssSafeId(state.selectedSegmentKey)}`)?.classList.add("selected");
  }
  for (const divider of document.querySelectorAll(".turnDivider.active")) {
    divider.classList.remove("active");
  }
  if (state.selectedTurnId) {
    document.querySelector(`#turn-${cssSafeId(state.selectedTurnId)}`)?.classList.add("active");
  }
  for (const row of document.querySelectorAll(".sessionTurnRow.active")) {
    row.classList.remove("active");
  }
  if (state.selectedTurnId) {
    document.querySelector(`.sessionTurnRow[data-turn-id="${cssEscape(state.selectedTurnId)}"]`)?.classList.add("active");
  }
}

function findSelectedSegment(session) {
  if (!state.selectedSegmentKey) return null;
  for (const turn of session.turns) {
    const block = turn.blocks.find((candidate) => candidate.key === state.selectedSegmentKey);
    if (block) return { block, turn };
  }
  state.selectedSegmentKey = "";
  return null;
}

function renderSegmentDetail(selection) {
  if (!selection) {
    els.segmentDetail.classList.remove("open");
    els.segmentDetailTitle.textContent = "Segment detail";
    els.segmentDetailMeta.textContent = "Select a segment.";
    els.segmentContentPre.textContent = "Select a turn segment to inspect content.";
    els.segmentRawMeta.textContent = "Select a segment.";
    els.segmentRawPre.textContent = "Select a turn segment to inspect raw events.";
    closeSegmentRaw();
    return;
  }
  const { block, turn } = selection;
  const body = blockText(block) || "(empty)";
  const displayedBody = truncateForDisplay(body);
  const truncated = displayedBody.length !== body.length;
  const raw = block.events.map((event) => {
    const { viewId: _viewId, ...displayEvent } = event;
    return displayEvent;
  });
  els.segmentDetail.classList.add("open");
  els.segmentDetailTitle.textContent = `${block.label} / ${block.meta || block.kind}`;
  els.segmentDetailMeta.textContent = [`Turn ${shortId(turn.id)}`, `${block.events.length} events`, eventTime(block.events[0] || {})].filter(Boolean).join(" / ");
  els.segmentRawMeta.textContent = [`Turn ${shortId(turn.id)}`, `${block.events.length} events`, eventTime(block.events[0] || {})].filter(Boolean).join(" / ");
  els.segmentContentPre.textContent = `${displayedBody}${truncated ? "\n\n[display truncated]" : ""}`;
  els.segmentRawPre.textContent = JSON.stringify(raw, null, 2);
}

function openSegmentRaw() {
  if (!state.selectedSegmentKey) return;
  els.segmentRawModal.classList.add("open");
  els.segmentRawBackdrop.classList.add("open");
}

function closeSegmentRaw() {
  els.segmentRawModal.classList.remove("open");
  els.segmentRawBackdrop.classList.remove("open");
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

function blockText(block) {
  if (block.kind === "command") {
    const parts = [];
    if (block.command) parts.push(`$ ${block.command}`);
    if (block.cwd) parts.push(`cwd: ${block.cwd}`);
    if (block.status || block.exitCode != null || block.durationMs != null) {
      parts.push(`status: ${[block.status, block.exitCode != null ? `exit=${block.exitCode}` : "", durationLabel(block.durationMs)].filter(Boolean).join(" / ")}`);
    }
    if (block.output) parts.push(block.output);
    return parts.join("\n\n");
  }
  if (block.kind === "tool") {
    const parts = [`${block.server || "mcp"}.${block.tool || "tool"}`];
    if (block.argumentsText) parts.push(block.argumentsText);
    if (block.resultText) parts.push(block.resultText);
    if (block.error) parts.push(`error: ${block.error}`);
    return parts.join("\n\n");
  }
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
    const session = getSession(sessionMap, threadId);
    applySessionMetadata(session, threadMetadata.get(threadId));
    session.events += 1;
    session.lastTs = Math.max(session.lastTs || 0, event.ts_ms || 0);
    session.source = mergeSourceLabel(session.source, event.source);
    const extracted = extractConversationEvent(event);
    if (!extracted) continue;
    const turnId = extracted.turnId || event.turnId || "unknown-turn";
    const turn = getTurn(session, turnId);
    applyTurnMeta(turn, event);
    if (extracted.block) {
      applyBlock(turn, extracted.block, event);
      if (!session.preview && extracted.block.preview) session.preview = extracted.block.preview;
    }
  }
  const sessions = [...sessionMap.values()];
  for (const session of sessions) {
    session.turns.sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
    session.blocks = 0;
    for (const turn of session.turns) {
      turn.blocks.sort((a, b) => (a.firstSeq || 0) - (b.firstSeq || 0));
      session.blocks += turn.blocks.length;
    }
  }
  sessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return { sessions };
}

function getSession(map, id) {
  if (!map.has(id)) {
    map.set(id, { id, title: "", cwd: "", threadPreview: "", turnsById: new Map(), turns: [], events: 0, blocks: 0, preview: "", lastTs: 0, source: "" });
  }
  return map.get(id);
}

function buildThreadMetadata(events) {
  const metadata = new Map();
  for (const event of events) {
    const directId = stringValue(event.threadId);
    if (directId && (event.threadName || event.threadPreview || event.threadCwd)) {
      mergeThreadMetadata(metadata, {
        id: directId,
        title: stringValue(event.threadName),
        preview: stringValue(event.threadPreview),
        cwd: stringValue(event.threadCwd),
        updatedAt: numericTimestamp(event.ts_ms),
      });
    }
    const data = event.rawJson?.result?.data;
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const id = stringValue(item.id || item.threadId || item.thread_id);
      if (!id) continue;
      mergeThreadMetadata(metadata, {
        id,
        title: stringValue(item.name || item.title),
        preview: stringValue(item.preview),
        cwd: stringValue(item.cwd || item.path),
        updatedAt: numericTimestamp(item.updatedAt ?? item.updated_at ?? item.recencyAt ?? item.recency_at ?? item.createdAt ?? item.created_at),
      });
    }
  }
  return metadata;
}

function mergeThreadMetadata(metadata, next) {
  if (!next.id || (!next.title && !next.preview && !next.cwd)) return;
  const current = metadata.get(next.id) || { updatedAt: 0, title: "", preview: "", cwd: "" };
  const newer = next.updatedAt >= current.updatedAt;
  const title = chooseMetadataText(current.title, next.title, newer);
  const preview = chooseMetadataText(current.preview, next.preview, newer);
  const cwd = chooseMetadataText(current.cwd, next.cwd, newer);
  metadata.set(next.id, {
    updatedAt: Math.max(current.updatedAt, next.updatedAt),
    title,
    preview,
    cwd,
  });
}

function chooseMetadataText(current, next, newer) {
  if (!next) return current;
  if (!current) return next;
  if (current.length >= next.length && looksLikeDamagedText(next)) return current;
  return newer ? next : current;
}

function applySessionMetadata(session, metadata) {
  if (!metadata) return;
  if (metadata.title) session.title = metadata.title;
  if (metadata.preview) session.threadPreview = metadata.preview;
  if (metadata.cwd) session.cwd = metadata.cwd;
}

function mergeSourceLabel(current, next) {
  const value = next || "local";
  if (!current) return value;
  if (current === value) return current;
  return "mixed";
}

function sessionTitle(session) {
  return session.title || session.threadPreview || session.preview || `Session ${shortId(session.id)}`;
}

function stringValue(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return looksLikeDamagedText(text) ? "" : text;
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
    const turn = { id, blocksByKey: new Map(), blocks: [], firstTs: 0, status: "", durationMs: null };
    session.turnsById.set(id, turn);
    session.turns.push(turn);
  }
  return session.turnsById.get(id);
}

function applyTurnMeta(turn, event) {
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

function applyBlock(turn, update, event) {
  const key = update.key || `${update.kind}:${event.viewId}`;
  let block = turn.blocksByKey.get(key);
  if (!block) {
    block = {
      ...update,
      key,
      events: [],
      firstSeq: event.seq ?? event.viewId,
      firstTs: event.ts_ms || 0,
      text: "",
      output: "",
    };
    turn.blocksByKey.set(key, block);
    turn.blocks.push(block);
  }
  block.events.push(event);
  block.meta = update.meta || block.meta;
  block.status = update.status ?? block.status;
  block.exitCode = update.exitCode ?? block.exitCode;
  block.durationMs = update.durationMs ?? block.durationMs;
  for (const field of ["label", "role", "kind", "command", "cwd", "server", "tool", "argumentsText", "resultText", "error", "changes", "plan", "diff", "revisedPrompt", "savedPath"]) {
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
      <span class="ids">${escapeHtml([shortId(event.threadId), shortId(event.turnId), shortId(event.itemId)].filter(Boolean).join(" / "))}</span>
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
  els.statusLine.textContent = `${sourceState} | seq ${status?.lastSeq ?? 0} | buffered ${status?.bufferedEvents ?? 0} | ingested ${status?.totalIngested ?? 0} | http ${status?.clients ?? 0} | ingest ${status?.ingestClients ?? 0} | ${status?.ingest ?? ""}`;
}

function addEvent(event) {
  if (state.paused) return;
  state.events.push(ingestEvent(event));
  const max = Math.max(5000, Number(els.limitInput.value || "1000") * 2);
  if (state.events.length > max) {
    state.events.splice(0, state.events.length - max);
  }
  scheduleRender();
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
  const [eventsRes] = await Promise.all([fetch(`/api/events?limit=${encodeURIComponent(limit)}&compact=1`), refreshConversationModel()]);
  state.nextViewId = 1;
  state.events = (await eventsRes.json()).map(ingestEvent);
  render();
}

async function refreshConversationModel() {
  try {
    const res = await fetch("/api/conversations");
    if (!res.ok) return;
    state.conversationModel = await res.json();
  } catch {
    state.conversationModel = state.conversationModel || null;
  }
}

function scheduleConversationRefresh() {
  if (state.conversationRefreshScheduled) return;
  state.conversationRefreshScheduled = true;
  setTimeout(async () => {
    state.conversationRefreshScheduled = false;
    await refreshConversationModel();
    scheduleRender();
  }, 250);
}

function connectSse() {
  const source = new EventSource("/events?compact=1");
  source.addEventListener("event", (message) => {
    addEvent(JSON.parse(message.data));
    scheduleConversationRefresh();
  });
  source.addEventListener("status", (message) => {
    updateStatus(JSON.parse(message.data));
  });
  source.onerror = () => {
    els.statusLine.textContent = "SSE disconnected; retrying...";
  };
}

for (const el of [els.dirFilter, els.methodFilter, els.threadFilter, els.textFilter, els.limitInput]) {
  el.addEventListener("input", render);
}

els.conversationTabBtn.addEventListener("click", () => {
  state.activeTab = "conversation";
  render();
});

els.timelineTabBtn.addEventListener("click", () => {
  state.activeTab = "timeline";
  render();
});

els.pauseBtn.addEventListener("click", () => {
  state.paused = !state.paused;
  els.pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  render();
});

els.clearBtn.addEventListener("click", () => {
  state.events = [];
  state.conversationModel = { version: 0, sessions: [] };
  state.selectedSessionId = "";
  state.expandedSessionId = "";
  state.selectedTurnId = "";
  state.selectedSegmentKey = "";
  closeDetail();
});

els.closeDetailBtn.addEventListener("click", closeDetail);
els.closeSegmentDetailBtn.addEventListener("click", () => {
  state.selectedSegmentKey = "";
  renderSegmentsActiveState();
  renderSegmentDetail(null);
});
els.openSegmentRawBtn.addEventListener("click", openSegmentRaw);
els.closeSegmentRawBtn.addEventListener("click", closeSegmentRaw);
els.segmentRawBackdrop.addEventListener("click", closeSegmentRaw);
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

await loadInitial();
connectSse();
