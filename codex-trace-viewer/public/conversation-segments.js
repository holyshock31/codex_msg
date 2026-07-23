export function aggregateKeyForUpdate(update, event, fallbackIndex = 0) {
  return (
    update.aggregateKey ||
    update.key ||
    `${update.kind || "event"}:${event.seq ?? event.viewId ?? event.ts_ms ?? fallbackIndex}`
  );
}

export function canMergeContinuousSegment(previous, update, aggregateKey) {
  if (!previous || previous.aggregateKey !== aggregateKey) return false;
  return previous.kind === update.kind && previous.role === update.role;
}

export function segmentKeyForAggregate(aggregateKey, event, fallbackIndex = 0) {
  const occurrence = event.seq ?? event.viewId ?? event.ts_ms ?? fallbackIndex;
  return `${aggregateKey}:segment:${occurrence}`;
}

export function resolveContinuousSegment(turn, update, event) {
  const aggregateKey = aggregateKeyForUpdate(update, event, turn.blocks.length);
  const previous = turn.blocks.at(-1);
  if (canMergeContinuousSegment(previous, update, aggregateKey)) {
    return { aggregateKey, block: previous, isNew: false };
  }
  const matchingSnapshot = findMatchingSnapshotSegment(turn.blocks, update, aggregateKey);
  if (matchingSnapshot) {
    return { aggregateKey, block: matchingSnapshot, isNew: false, reusedSnapshot: true };
  }
  return {
    aggregateKey,
    block: null,
    isNew: true,
    segmentKey: segmentKeyForAggregate(aggregateKey, event, turn.blocks.length),
  };
}

function findMatchingSnapshotSegment(blocks, update, aggregateKey) {
  if (update.kind !== "diff" || typeof update.diff !== "string") return null;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.aggregateKey === aggregateKey && block.kind === "diff" && block.diff === update.diff) return block;
  }
  return null;
}

export function buildAggregateGroups(blocks = []) {
  const groupsByKey = new Map();
  for (const block of blocks) {
    const aggregateKey = block.aggregateKey || block.key;
    if (!aggregateKey) continue;
    let group = groupsByKey.get(aggregateKey);
    if (!group) {
      group = {
        key: aggregateKey,
        kind: block.kind,
        role: block.role,
        label: block.label,
        segments: [],
        eventCount: 0,
        firstSeq: block.firstSeq ?? null,
        lastSeq: block.lastSeq ?? block.firstSeq ?? null,
        firstTs: block.firstTs || 0,
        lastTs: block.lastTs || block.firstTs || 0,
        latest: block,
      };
      groupsByKey.set(aggregateKey, group);
    }
    group.segments.push(block);
    group.eventCount += block.eventCount || block.events?.length || 0;
    group.lastSeq = block.lastSeq ?? block.firstSeq ?? group.lastSeq;
    group.lastTs = block.lastTs || block.firstTs || group.lastTs;
    group.latest = block;
    if (!group.label && block.label) group.label = block.label;
  }

  const groups = [...groupsByKey.values()];
  for (const group of groups) {
    group.segments.forEach((block, index) => {
      block.aggregatePart = index + 1;
      block.aggregateParts = group.segments.length;
      block.aggregateEventCount = group.eventCount;
    });
  }
  return groups.sort((a, b) => (a.firstSeq || 0) - (b.firstSeq || 0));
}

export function buildMultiPartAggregateGroups(blocks = []) {
  return buildAggregateGroups(blocks).filter(
    (group) => new Set(group.segments.map((segment) => segment.key).filter(Boolean)).size > 1,
  );
}

const aggregateRailKinds = new Set(["plan", "diff", "file", "command"]);

export function buildAggregateRailGroups(blocks = []) {
  return buildMultiPartAggregateGroups(blocks).filter((group) => aggregateRailKinds.has(group.kind));
}
