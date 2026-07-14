# Trace Viewer Scroll Performance Notes

## Background

The review page can render very large Codex sessions. In the current data set, the largest normal thread has roughly:

- 49 turns
- 1,841 conversation blocks
- 7,626 source events
- about 7.7 MB of block text

Across all loaded conversations there are also several very large command-output blocks:

- 4 blocks over 1 MB
- 11 blocks over 200 KB
- 29 blocks over 50 KB
- 114 blocks over 10 KB

This explains why scrolling can feel acceptable in the Codex in-app browser but laggy in Vivaldi. Both are Chromium-based, but Vivaldi may have different compositor settings, extensions, hardware acceleration state, and tab UI overhead. The page should not depend on a browser being unusually tolerant of a large DOM.

## Root Causes

### Full DOM Rendering

`renderConversation()` currently renders every visible turn and every visible block for the selected thread into `.conversationMessages`. For the largest thread that means more than 1,800 message cards in one scroll container.

This affects:

- layout work during scroll
- paint invalidation
- selector matching when selection state changes
- memory pressure

### Preview Generation Builds Large Strings

For normal cards, `segmentCard()` used to call `blockText(block)` before creating a short preview. For command/file/diff blocks this can build very large strings first and then truncate them to a short inline preview.

This is unnecessary for the collapsed list. Full text is only needed when a segment is selected and shown in the detail panel.

### Expensive Scroll Paint

The scroll area contains many cards with borders, shadows, transitions, and some overlay surfaces using `backdrop-filter`. These are useful visually, but they increase paint/compositing cost when thousands of elements exist in the same scrolling context.

## Optimization Plan

### Phase 1: Low-Risk Rendering Cost Reduction

Scope: keep the same UI structure and interaction model.

Changes:

- Generate card previews from existing compact fields and bounded snippets instead of full `blockText()` output.
- Add `content-visibility: auto` and `contain-intrinsic-size` to message cards, allowing Chromium browsers to skip rendering off-screen cards.
- Reduce scroll-path paint cost by removing default box shadows from every card and using shadows only for hover/selection.
- Remove `backdrop-filter` from the always-visible segment rail and use an opaque background instead.
- Keep selected, hover, and context-compaction affordances intact.

Expected result:

- Faster initial render for large command-output sessions.
- Less per-scroll paint work in Vivaldi.
- No data-model change and no change to session/thread/turn/block semantics.

Limitations:

- DOM node count remains high.
- Browser still has to maintain the full scroll tree.
- Very large sessions may still stutter on weaker graphics settings.

### Phase 2: Conversation Virtualization

Scope: larger UI change.

Render only blocks near the viewport, with top/bottom spacers preserving scroll height.

Required design points:

- The left segment rail must keep all item numbers available, while the right content only mounts nearby cards.
- Jumping from rail to a block must compute or estimate offset and then mount the target block.
- Turn start/end dividers need to participate in the same virtual item list as blocks.
- Selected segment detail should remain stable even when the selected card is unmounted.
- Search/filter results should still be able to jump to a target item.

This is the long-term fix for threads with thousands of blocks.

### Phase 3: Data Paging

Scope: backend/API change.

Instead of returning all conversation block payloads for all restored sessions, add APIs that page by session/thread/turn and fetch heavy block detail on demand.

Candidate API shape:

- `GET /api/conversations/summary`
- `GET /api/conversations/:sessionId/threads/:threadId/turns`
- `GET /api/conversations/:sessionId/threads/:threadId/turns/:turnId/blocks`
- `GET /api/block-detail?...`

This would reduce memory and startup cost, but it is more invasive than Phase 1 and Phase 2.

## Validation

Minimum checks after Phase 1:

- `node --check codex-trace-viewer/public/app.js`
- `node --check codex-trace-viewer/server.js`
- Load `http://127.0.0.1:45123/`
- Open the largest conversation and verify:
  - turn ordering still works
  - segment rail still jumps to the correct block
  - selected block detail still shows full content
  - Vivaldi wheel scrolling is smoother than before

Useful future metrics:

- number of `.segmentCard` nodes in DOM
- time spent in `renderConversation()`
- long task count during wheel scroll
- largest block preview generation time

