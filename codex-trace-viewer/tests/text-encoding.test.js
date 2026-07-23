import assert from "node:assert/strict";
import test from "node:test";

import iconv from "iconv-lite";

import { applyCommandOutputEncodings, diagnoseTextEncoding } from "../text-encoding.js";

function asCp936Mojibake(text) {
  return iconv.decode(Buffer.from(text, "utf8"), "gbk");
}

test("recovers UTF-8 text that was decoded as CP936", () => {
  const expected = "codex进行computer use的原理是什么，会截图吗";
  const source = "codex杩涜computer use鐨勫師鐞嗘槸浠€涔堬紝浼氭埅鍥惧悧";
  const result = diagnoseTextEncoding(source, {
    command: 'powershell.exe -Command "Get-Content -Raw file.txt"',
  });

  assert.ok(result);
  assert.equal(result.recoveredText, expected);
  assert.equal(result.pattern, "utf8-decoded-as-cp936");
  assert.equal(result.recovery, "exact");
  assert.equal(result.defaultDisplay, "recovered");
  assert.ok(result.confidence >= 0.82);
});

test("preserves normal Chinese and ASCII output", () => {
  assert.equal(diagnoseTextEncoding("正常的中文输出。\nstatus: completed"), null);
  assert.equal(diagnoseTextEncoding("plain ASCII output"), null);
});

test("repairs only suspicious lines in mixed output", () => {
  const expected = "codex进行computer use的原理是什么，会截图吗";
  const source = `status: completed\ncodex杩涜computer use鐨勫師鐞嗘槸浠€涔堬紝浼氭埅鍥惧悧\nexit: 0`;
  const result = diagnoseTextEncoding(source);

  assert.ok(result);
  assert.equal(result.recoveredText, `status: completed\n${expected}\nexit: 0`);
  assert.equal(result.repairedLines, 1);
});

test("recovers short mojibake headings without known marker characters", () => {
  const result = diagnoseTextEncoding("## 鑳屾櫙");

  assert.ok(result);
  assert.equal(result.recoveredText, "## 背景");
});

test("marks lossy recovery as partial", () => {
  const expected = "可以把 Codex 的 computer use 理解成电脑工具，并继续读取界面状态。".repeat(4);
  const source = asCp936Mojibake(expected);
  const result = diagnoseTextEncoding(source, {
    command: 'WindowsPowerShell\\v1.0\\powershell.exe -Command "Get-Content -Raw file.txt"',
  });

  assert.ok(result);
  assert.equal(result.recovery, "partial");
  assert.match(result.recoveredText, /Codex/);
});

test("accepts low-loss recovery when the source has strong mojibake evidence", () => {
  const expected = "常驻 daemon 负责转发消息，当前连接继续复用。";
  const source = asCp936Mojibake(expected);
  const result = diagnoseTextEncoding(source);

  assert.ok(result);
  assert.match(result.recoveredText, /常驻 daemon/);
  assert.equal(result.recovery, "partial");
});

test("defaults multi-line PowerShell Get-Content recovery to the readable result", () => {
  const expected = [
    "当前 Windows 本机方案通过 CODEX_CLI_PATH 启动 Codex Desktop。",
    "远端 wrapper 继续把消息转发到 Viewer。",
  ].join("\n");
  const result = diagnoseTextEncoding(asCp936Mojibake(expected), {
    command: 'powershell.exe -Command "Get-Content -Raw file.txt"',
  });

  assert.ok(result);
  assert.ok(result.repairedLines >= 2);
  assert.ok(result.confidence >= 0.7);
  assert.equal(result.defaultDisplay, "recovered");
});

test("keeps a low-confidence single-line partial recovery on the original text", () => {
  const expected = "常驻 daemon：";
  const result = diagnoseTextEncoding(asCp936Mojibake(expected), {
    command: 'powershell.exe -Command "Get-Content file.txt"',
  });

  assert.ok(result);
  assert.equal(result.repairedLines, 1);
  assert.ok(result.confidence < 0.78);
  assert.equal(result.defaultDisplay, "original");
});

test("adds encoding recovery to command output parts using aggregate command context", () => {
  const command = 'powershell.exe -Command "Get-Content -Raw file.md"';
  const expected = "# docs +create（创建飞书云文档）\n生成文档内容前，必须读取参考文件。";
  const blocks = [
    { key: "exec-1:segment:1", aggregateKey: "exec-1", kind: "command", command, output: "" },
    { key: "exec-1:segment:2", aggregateKey: "exec-1", kind: "command", meta: "output", output: asCp936Mojibake(expected) },
    { key: "exec-1:segment:3", aggregateKey: "exec-1", kind: "command", command, output: asCp936Mojibake(expected) },
  ];

  applyCommandOutputEncodings(blocks);

  assert.equal(blocks[0].outputEncoding, undefined);
  assert.ok(blocks[1].outputEncoding);
  assert.match(blocks[1].outputEncoding.recoveredText, /docs \+create/);
  assert.match(blocks[1].outputEncoding.recoveredText, /生成文档内容前/);
  assert.ok(blocks[2].outputEncoding);
});

test("refreshes a command part recovery when more output is appended", () => {
  const command = 'powershell.exe -Command "Get-Content -Raw file.md"';
  const block = {
    key: "exec-2:segment:1",
    aggregateKey: "exec-2",
    kind: "command",
    command,
    output: asCp936Mojibake("# 背景"),
  };

  applyCommandOutputEncodings([block]);
  const firstRecovered = block.outputEncoding.recoveredText;
  block.output += `\n${asCp936Mojibake("当前 Windows 本机方案")}`;
  applyCommandOutputEncodings([block]);

  assert.notEqual(block.outputEncoding.recoveredText, firstRecovered);
  assert.match(block.outputEncoding.recoveredText, /当前 Windows 本机方案/);
});

test("uses a trusted completed command recovery as the default for shorter output parts", () => {
  const command = 'powershell.exe -Command "Get-Content -Raw file.md"';
  const shortOutput = asCp936Mojibake("常驻 daemon：");
  const fullOutput = asCp936Mojibake(
    ["常驻 daemon：", "当前 Windows 本机方案通过 wrapper 转发消息。", "远端连接继续复用 Viewer。"].join("\n"),
  );
  const blocks = [
    { key: "exec-3:segment:1", aggregateKey: "exec-3", kind: "command", command, output: "" },
    { key: "exec-3:segment:2", aggregateKey: "exec-3", kind: "command", meta: "output", output: shortOutput },
    {
      key: "exec-3:segment:3",
      aggregateKey: "exec-3",
      kind: "command",
      meta: "completed",
      status: "completed",
      command,
      output: fullOutput,
    },
  ];

  applyCommandOutputEncodings(blocks);

  assert.ok(blocks[1].outputEncoding);
  assert.equal(blocks[2].outputEncoding.defaultDisplay, "recovered");
  assert.equal(blocks[1].outputEncoding.defaultDisplay, "recovered");
  assert.equal(blocks[1].outputEncoding.aggregateConfidence, blocks[2].outputEncoding.confidence);
});
