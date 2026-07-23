import iconv from "iconv-lite";

const utf8Decoder = new TextDecoder("utf-8");
const commandOutputEncodingCache = new WeakMap();
const mojibakeMarkers = /[鐨斤拷鐵閿鈷杩涓繘鏄鍏浠鎴妫銆鈵鍊浼娑閏瀒紱缂如瀉顣涓娴纯濉浠紝灏绠顏崲鐩鍙宀涓]/gu;
const mojibakeSequences = ["锟斤拷", "鍙囧", "鐨", "閿", "鈷", "杩涓", "鐵", "鏄", "鍏", "浠", "鎴", "閏", "瀒"];

export function diagnoseTextEncoding(value, context = {}) {
  const source = String(value || "");
  if (!source || source.length < 4) return null;

  const parts = source.split(/(\r\n|\n|\r)/);
  let repairedLines = 0;
  let repairedChars = 0;
  let sourcePenalty = 0;
  let recoveredPenalty = 0;
  let replacementCount = 0;
  let exactLines = 0;

  const recoveredParts = parts.map((part) => {
    if (/^(\r\n|\n|\r)$/.test(part)) return part;
    const repair = repairTextPart(part);
    if (!repair) return part;
    repairedLines += 1;
    repairedChars += part.length;
    sourcePenalty += repair.sourcePenalty;
    recoveredPenalty += repair.recoveredPenalty;
    replacementCount += repair.replacementCount;
    if (repair.exact) exactLines += 1;
    return repair.recovered;
  });

  if (!repairedLines) return null;
  const recoveredText = recoveredParts.join("");
  if (recoveredText === source) return null;

  const improvement = sourcePenalty > 0 ? Math.max(0, (sourcePenalty - recoveredPenalty) / sourcePenalty) : 0;
  const replacementRatio = repairedChars > 0 ? replacementCount / repairedChars : 0;
  const commandEvidence = powerShellGetContentWithoutEncoding(context.command);
  const confidence = clamp(
    0.66 + Math.min(0.24, improvement * 0.24) + (commandEvidence ? 0.08 : 0) - Math.min(0.18, replacementRatio * 4),
    0,
    0.99,
  );
  const roundedConfidence = Math.round(confidence * 100) / 100;
  const recovery = replacementCount > 0 || exactLines !== repairedLines ? "partial" : "exact";
  const defaultToRecovered =
    roundedConfidence >= 0.78 || (commandEvidence && repairedLines >= 2 && roundedConfidence >= 0.7);
  const evidence = [
    "CP936 bytes produce a more readable UTF-8 candidate",
    `${repairedLines} line${repairedLines === 1 ? "" : "s"} improved`,
  ];
  if (commandEvidence) evidence.push("Windows PowerShell Get-Content without -Encoding");
  if (replacementCount > 0) evidence.push(`${replacementCount} unrecoverable byte sequence${replacementCount === 1 ? "" : "s"}`);

  return {
    pattern: "utf8-decoded-as-cp936",
    sourceEncoding: "cp936",
    targetEncoding: "utf-8",
    confidence: roundedConfidence,
    recovery,
    defaultDisplay: defaultToRecovered ? "recovered" : "original",
    repairedLines,
    repairedChars,
    replacementCount,
    evidence,
    recoveredText,
  };
}

export function applyCommandOutputEncodings(blocks) {
  const commandByAggregate = new Map();
  const blocksByAggregate = new Map();
  for (const block of blocks || []) {
    if (block?.kind !== "command") continue;
    const aggregateKey = commandAggregateKey(block);
    if (!blocksByAggregate.has(aggregateKey)) blocksByAggregate.set(aggregateKey, []);
    blocksByAggregate.get(aggregateKey).push(block);
    if (block.command) commandByAggregate.set(aggregateKey, block.command);
  }

  for (const block of blocks || []) {
    if (block?.kind !== "command" || !block.output) continue;
    const command = block.command || commandByAggregate.get(commandAggregateKey(block));
    if (!command) continue;
    const signature = `${command}\u0000${block.output}`;
    const cached = commandOutputEncodingCache.get(block);
    if (cached?.signature === signature) {
      if (cached.outputEncoding) block.outputEncoding = cached.outputEncoding;
      else delete block.outputEncoding;
      continue;
    }
    const outputEncoding = diagnoseTextEncoding(block.output, { command });
    if (outputEncoding) block.outputEncoding = outputEncoding;
    else delete block.outputEncoding;
    commandOutputEncodingCache.set(block, { signature, outputEncoding });
  }

  for (const aggregateBlocks of blocksByAggregate.values()) {
    const authority = commandEncodingAuthority(aggregateBlocks);
    if (authority?.outputEncoding?.defaultDisplay !== "recovered") continue;
    for (const block of aggregateBlocks) {
      if (!block.outputEncoding || block.outputEncoding.defaultDisplay === "recovered") continue;
      block.outputEncoding = {
        ...block.outputEncoding,
        defaultDisplay: "recovered",
        aggregateConfidence: authority.outputEncoding.confidence,
        aggregateRecovery: authority.outputEncoding.recovery,
        evidence: [...(block.outputEncoding.evidence || []), "Command aggregate recovery supports this output part"],
      };
    }
  }
  return blocks;
}

function commandAggregateKey(block) {
  return block.aggregateKey || block.itemId || block.key || "";
}

function commandEncodingAuthority(blocks) {
  const diagnosed = blocks.filter((block) => block.outputEncoding);
  if (!diagnosed.length) return null;
  const completed = diagnosed.filter((block) => block.status === "completed" || block.meta === "completed");
  return (completed.length ? completed : diagnosed).reduce((best, block) =>
    String(block.output || "").length > String(best.output || "").length ? block : best,
  );
}

function repairTextPart(source) {
  const sourceStats = encodingStats(source);
  if (sourceStats.signal < 3 && sourceStats.hanCount < 2) return null;

  const bytes = iconv.encode(source, "gbk");
  const recovered = utf8Decoder.decode(bytes);
  if (!recovered || recovered === source) return null;

  const recoveredStats = encodingStats(recovered);
  const minimumImprovement = Math.max(4, sourceStats.penalty * 0.25);
  const replacementRatio = recoveredStats.replacementCount / Math.max(1, recovered.length);
  const penaltyImproved = sourceStats.penalty - recoveredStats.penalty >= minimumImprovement;
  const lengthReduction = (source.length - recovered.length) / Math.max(1, source.length);
  const legacyStructureImproved =
    sourceStats.hanCount >= 2 && recoveredStats.hanCount >= 1 && lengthReduction >= 0.08 && replacementRatio <= 0.12;
  const strongSignalRecovery =
    sourceStats.signal >= 3 &&
    sourceStats.hanCount >= 2 &&
    recoveredStats.hanCount >= 1 &&
    lengthReduction >= 0.01 &&
    replacementRatio <= 0.08;
  const structureImproved = legacyStructureImproved || strongSignalRecovery;
  if (!penaltyImproved && !structureImproved) return null;
  if (replacementRatio > 0.18) return null;

  const roundTrip = iconv.decode(Buffer.from(recovered, "utf8"), "gbk");
  const structuralPenalty = structureImproved ? Math.max(4, Math.round((source.length - recovered.length) * 2)) : 0;
  return {
    recovered,
    sourcePenalty: Math.max(sourceStats.penalty, structuralPenalty),
    recoveredPenalty: recoveredStats.penalty,
    replacementCount: recoveredStats.replacementCount,
    exact: recoveredStats.replacementCount === 0 && roundTrip === source,
  };
}

function encodingStats(value) {
  const text = String(value || "");
  const hanCount = countMatches(text, /\p{Script=Han}/gu);
  const privateUseCount = countMatches(text, /[\uE000-\uF8FF]/gu);
  const replacementCount = countMatches(text, /\uFFFD/gu);
  const markerCount = countMatches(text, mojibakeMarkers);
  const sequenceCount = mojibakeSequences.reduce((total, marker) => total + countOccurrences(text, marker), 0);
  const signal = privateUseCount * 3 + replacementCount * 3 + markerCount + sequenceCount * 3;
  return {
    signal,
    penalty: privateUseCount * 8 + replacementCount * 10 + markerCount * 2 + sequenceCount * 5,
    replacementCount,
    hanCount,
  };
}

function powerShellGetContentWithoutEncoding(command) {
  const text = String(command || "");
  return /(?:powershell(?:\.exe)?|WindowsPowerShell)/i.test(text) && /\bGet-Content\b/i.test(text) && !/-Encoding\b/i.test(text);
}

function countMatches(text, pattern) {
  pattern.lastIndex = 0;
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}

function countOccurrences(text, marker) {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(marker, offset);
    if (index < 0) break;
    count += 1;
    offset = index + marker.length;
  }
  return count;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
