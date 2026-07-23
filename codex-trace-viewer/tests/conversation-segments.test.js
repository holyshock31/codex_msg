import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAggregateRailGroups,
  buildAggregateGroups,
  buildMultiPartAggregateGroups,
  resolveContinuousSegment,
} from "../public/conversation-segments.js";

function turn() {
  return { blocks: [] };
}

function addSegment(target, update, event) {
  const result = resolveContinuousSegment(target, update, event);
  if (result.isNew) {
    result.block = {
      ...update,
      key: result.segmentKey,
      aggregateKey: result.aggregateKey,
      firstSeq: event.seq,
      lastSeq: event.seq,
      firstTs: event.ts_ms,
      lastTs: event.ts_ms,
      events: [],
    };
    target.blocks.push(result.block);
  }
  result.block.events.push(event);
  result.block.lastSeq = event.seq;
  result.block.lastTs = event.ts_ms;
  return result.block;
}

test("merges only adjacent compatible occurrences", () => {
  const target = turn();
  const command = { key: "item:a", kind: "command", role: "tool", label: "command" };
  addSegment(target, command, { seq: 1, ts_ms: 10 });
  addSegment(target, command, { seq: 2, ts_ms: 20 });

  assert.equal(target.blocks.length, 1);
  assert.equal(target.blocks[0].events.length, 2);
});

test("creates a continuation segment after another visible item", () => {
  const target = turn();
  const commandA = { key: "item:a", kind: "command", role: "tool", label: "command" };
  const commandB = { key: "item:b", kind: "command", role: "tool", label: "command" };
  addSegment(target, commandA, { seq: 1, ts_ms: 10 });
  addSegment(target, commandB, { seq: 2, ts_ms: 20 });
  addSegment(target, commandB, { seq: 3, ts_ms: 30 });
  addSegment(target, commandA, { seq: 4, ts_ms: 40 });

  assert.deepEqual(
    target.blocks.map((block) => [block.aggregateKey, block.events.length]),
    [
      ["item:a", 1],
      ["item:b", 2],
      ["item:a", 1],
    ],
  );
});

test("keeps plan revisions in order and groups them separately", () => {
  const target = turn();
  const plan = { key: "plan:turn-1", kind: "plan", role: "plan", label: "plan" };
  const command = { key: "item:a", kind: "command", role: "tool", label: "command" };
  addSegment(target, plan, { seq: 1, ts_ms: 10 });
  addSegment(target, command, { seq: 2, ts_ms: 20 });
  addSegment(target, plan, { seq: 3, ts_ms: 30 });

  const groups = buildAggregateGroups(target.blocks);
  const planGroup = groups.find((group) => group.key === "plan:turn-1");

  assert.equal(target.blocks.length, 3);
  assert.equal(planGroup.segments.length, 2);
  assert.equal(planGroup.firstSeq, 1);
  assert.equal(planGroup.lastSeq, 3);
  assert.deepEqual(planGroup.segments.map((block) => block.aggregatePart), [1, 2]);
});

test("only exposes aggregates made from multiple timeline items", () => {
  const target = turn();
  const command = { key: "item:a", kind: "command", role: "tool", label: "command" };
  const otherCommand = { key: "item:b", kind: "command", role: "tool", label: "command" };
  const plan = { key: "plan:turn-1", kind: "plan", role: "plan", label: "plan" };
  addSegment(target, command, { seq: 1, ts_ms: 10 });
  addSegment(target, command, { seq: 2, ts_ms: 20 });
  addSegment(target, plan, { seq: 3, ts_ms: 30 });
  addSegment(target, otherCommand, { seq: 4, ts_ms: 40 });
  addSegment(target, plan, { seq: 5, ts_ms: 50 });

  const groups = buildMultiPartAggregateGroups(target.blocks);
  assert.deepEqual(groups.map((group) => group.key), ["plan:turn-1"]);
});

test("does not count duplicate references as multiple aggregate items", () => {
  const block = {
    key: "item:a:segment:1",
    aggregateKey: "item:a",
    kind: "command",
    role: "tool",
    firstSeq: 1,
    lastSeq: 2,
    events: [{ seq: 1 }, { seq: 2 }],
  };

  assert.deepEqual(buildMultiPartAggregateGroups([block, block]), []);
});

test("keeps command lifecycle items in the aggregate rail", () => {
  const target = turn();
  const command = { key: "item:a", kind: "command", role: "tool", label: "command" };
  const other = { key: "item:b", kind: "thinking", role: "thinking", label: "think" };
  addSegment(target, command, { seq: 1, ts_ms: 10 });
  addSegment(target, other, { seq: 2, ts_ms: 20 });
  addSegment(target, command, { seq: 3, ts_ms: 30 });

  assert.deepEqual(buildAggregateRailGroups(target.blocks).map((group) => group.key), ["item:a"]);
});

test("reuses identical diff snapshots but preserves real revisions", () => {
  const target = turn();
  const diffA = { key: "diff:turn-1", kind: "diff", role: "file", label: "diff", diff: "+first" };
  const diffB = { ...diffA, diff: "+second" };
  const thinking = { key: "think:a", kind: "thinking", role: "thinking", label: "think" };
  addSegment(target, diffA, { seq: 1, ts_ms: 10 });
  addSegment(target, thinking, { seq: 2, ts_ms: 20 });
  addSegment(target, diffA, { seq: 3, ts_ms: 30 });
  addSegment(target, diffB, { seq: 4, ts_ms: 40 });

  assert.equal(target.blocks.length, 3);
  assert.equal(target.blocks[0].events.length, 2);
  assert.deepEqual(
    target.blocks.map((block) => [block.kind, block.diff || ""]),
    [
      ["diff", "+first"],
      ["thinking", ""],
      ["diff", "+second"],
    ],
  );
});
