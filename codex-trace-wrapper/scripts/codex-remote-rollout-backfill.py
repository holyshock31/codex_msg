#!/usr/bin/env python3
"""Backfill remote Codex rollout JSONL files into codex-trace-viewer.

Run this on the remote host where ~/.codex/sessions exists. It emits synthetic
app-server notification-shaped events to the viewer ingest socket.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_DAEMON = "tcp://127.0.0.1:45124"


def main() -> int:
    args = parse_args()
    paths = find_rollout_files(args)
    if not paths:
        print("no rollout files matched", file=sys.stderr)
        return 1

    seq = args.seq_base or now_ms() * 1000
    sent = 0
    skipped = 0
    sock = None
    try:
        if not args.dry_run:
            sock = connect_sink(args.daemon_url)
        for path in paths:
            try:
                result = backfill_file(sock, path, seq, args)
            except Exception as exc:  # noqa: BLE001 - best effort diagnostic tool
                print(f"backfill failed for {path}: {exc}", file=sys.stderr)
                skipped += 1
                continue
            seq += result["sent"]
            sent += result["sent"]
            skipped += result["skipped"]
            print(
                f"backfilled {path}: {result['sent']} events "
                f"for thread {result.get('thread_id') or '?'}",
                file=sys.stderr,
            )
    finally:
        if sock is not None:
            sock.close()

    print(json.dumps({"files": len(paths), "sent": sent, "skipped": skipped}, ensure_ascii=False))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill selected Codex subagent rollouts into a trusted trace viewer ingest."
    )
    parser.add_argument("--daemon-url", default=os.environ.get("CODEX_TRACE_DAEMON_URL", DEFAULT_DAEMON))
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME") or str(Path.home() / ".codex"))
    parser.add_argument("--parent-thread-id", action="append", default=[])
    parser.add_argument("--thread-id", action="append", default=[])
    parser.add_argument("--file", action="append", default=[])
    parser.add_argument("--source", default=os.environ.get("CODEX_TRACE_SOURCE", "remote"))
    parser.add_argument("--source-id", default=os.environ.get("CODEX_TRACE_SOURCE_ID", "remote-rollout-backfill"))
    parser.add_argument("--seq-base", type=int, default=0)
    parser.add_argument("--max-events-per-file", type=int, default=2000)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not (args.parent_thread_id or args.thread_id or args.file):
        parser.error("select rollout files with --parent-thread-id, --thread-id, or --file")
    return args


def find_rollout_files(args: argparse.Namespace) -> list[str]:
    candidates: list[str] = []
    for path in args.file:
        candidates.append(path)

    sessions_dir = Path(args.codex_home) / "sessions"
    for thread_id in args.thread_id:
        candidates.extend(glob.glob(str(sessions_dir / "**" / f"rollout-*{thread_id}.jsonl"), recursive=True))

    if args.parent_thread_id:
        for path in glob.glob(str(sessions_dir / "**" / "rollout-*.jsonl"), recursive=True):
            meta = read_child_session_meta(path)
            if not is_subagent_meta(meta):
                continue
            if args.parent_thread_id and meta.get("parent_thread_id") not in set(args.parent_thread_id):
                continue
            candidates.append(path)

    return sorted(dict.fromkeys(candidates))


def read_child_session_meta(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                row = json.loads(line)
                if row.get("type") == "session_meta" and is_subagent_meta(row.get("payload") or {}):
                    return row.get("payload") or {}
    except Exception:
        return {}
    return {}


def is_subagent_meta(meta: dict[str, Any]) -> bool:
    return meta.get("thread_source") == "subagent" or isinstance(meta.get("source"), dict)


def connect_sink(url: str):
    scheme, _, address = url.partition("://")
    if scheme and scheme != "tcp":
        raise ValueError(f"unsupported daemon url: {url}")
    host, _, port_text = (address or scheme).rpartition(":")
    if not host:
        host = "127.0.0.1"
    return socket.create_connection((host, int(port_text)), timeout=5)


def backfill_file(sock: Any, path: str, start_seq: int, args: argparse.Namespace) -> dict[str, Any]:
    rows = read_rows(path)
    meta = next((row.get("payload") or {} for row in rows if row.get("type") == "session_meta" and is_subagent_meta(row.get("payload") or {})), {})
    if not meta:
        return {"sent": 0, "skipped": len(rows), "thread_id": ""}

    thread_id = str(meta.get("id") or "")
    parent_thread_id = str(meta.get("parent_thread_id") or meta.get("forked_from_id") or meta.get("session_id") or "")
    session_id = str(meta.get("session_id") or parent_thread_id or thread_id)
    start_index = child_turn_start_index(rows)
    active_turn_id = first_child_turn_id(rows, start_index) or f"{thread_id}:rollout"

    seq = start_seq
    sent = 0
    skipped = 0

    def emit(method: str, params: dict[str, Any], ts_ms: int) -> None:
        nonlocal seq, sent
        raw = json.dumps({"method": method, "params": params}, ensure_ascii=False, separators=(",", ":"))
        outer = {
            "schema": "codex.trace.event.v1",
            "seq": seq,
            "ts_ms": ts_ms,
            "pid": os.getpid(),
            "dir": "rollout_backfill",
            "raw": raw,
            "source": args.source,
            "source_id": args.source_id,
            "transport": "remote-rollout-jsonl",
            "connection_id": f"rollout:{thread_id}",
            "codec": "rollout-jsonl",
        }
        seq += 1
        sent += 1
        if not args.dry_run and sock is not None:
            sock.sendall((json.dumps(outer, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))

    meta_ts = timestamp_ms(meta.get("timestamp")) or timestamp_ms(rows[0].get("timestamp")) or now_ms()
    emit(
        "thread/started",
        {
            "thread": {
                "id": thread_id,
                "sessionId": session_id,
                "parentThreadId": parent_thread_id,
                "forkedFromId": str(meta.get("forked_from_id") or ""),
                "name": str(meta.get("agent_nickname") or meta.get("agent_path") or thread_id),
                "cwd": str(meta.get("cwd") or ""),
                "threadSource": "subagent",
                "agentNickname": str(meta.get("agent_nickname") or ""),
                "agentRole": str(meta.get("agent_role") or ""),
                "ephemeral": False,
            }
        },
        meta_ts,
    )
    emit(
        "turn/started",
        {
            "threadId": thread_id,
            "turn": {
                "id": active_turn_id,
                "status": "inProgress",
                "startedAt": iso_from_ms(meta_ts),
                "completedAt": None,
            },
        },
        meta_ts,
    )
    emit_item(
        emit,
        thread_id,
        active_turn_id,
        "userMessage",
        f"backfill-user:{thread_id}",
        {"content": [{"type": "input_text", "text": f"Subagent {meta.get('agent_nickname') or thread_id} started from {parent_thread_id}."}]},
        meta_ts,
    )

    for index, row in enumerate(rows[start_index:], start=start_index):
        if sent >= args.max_events_per_file:
            skipped += 1
            continue
        ts_ms = timestamp_ms(row.get("timestamp")) or meta_ts
        row_type = row.get("type")
        payload = row.get("payload") or {}
        next_turn_id = row_turn_id(row) or active_turn_id
        if row_type == "event_msg" and payload.get("type") == "task_started":
            active_turn_id = str(payload.get("turn_id") or active_turn_id)
            emit(
                "turn/started",
                {
                    "threadId": thread_id,
                    "turn": {
                        "id": active_turn_id,
                        "status": "inProgress",
                        "startedAt": iso_from_ms(ts_ms),
                        "completedAt": None,
                    },
                },
                ts_ms,
            )
            continue
        if not material_event(row):
            skipped += 1
            continue
        emitted = emit_material_row(emit, thread_id, next_turn_id, row, index, ts_ms)
        if not emitted:
            skipped += 1

    complete_ts = timestamp_ms(rows[-1].get("timestamp")) if rows else now_ms()
    emit(
        "turn/completed",
        {
            "threadId": thread_id,
            "turn": {
                "id": active_turn_id,
                "status": "completed",
                "startedAt": None,
                "completedAt": iso_from_ms(complete_ts),
            },
        },
        complete_ts,
    )
    return {"sent": sent, "skipped": skipped, "thread_id": thread_id}


def read_rows(path: str) -> list[dict[str, Any]]:
    rows = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def child_turn_start_index(rows: list[dict[str, Any]]) -> int:
    last_task_started = 0
    for index, row in enumerate(rows):
        payload = row.get("payload") or {}
        if row.get("type") == "event_msg" and payload.get("type") == "task_started":
            last_task_started = index
        if row.get("type") == "inter_agent_communication_metadata" and payload.get("trigger_turn") is True:
            return last_task_started
    return 0


def first_child_turn_id(rows: list[dict[str, Any]], start_index: int) -> str:
    for row in rows[start_index:]:
        turn_id = row_turn_id(row)
        if turn_id:
            return turn_id
    return ""


def row_turn_id(row: dict[str, Any]) -> str:
    payload = row.get("payload") or {}
    if row.get("type") == "turn_context":
        return str(payload.get("turn_id") or "")
    if row.get("type") == "event_msg":
        return str(payload.get("turn_id") or "")
    if row.get("type") == "response_item":
        return str((payload.get("internal_chat_message_metadata_passthrough") or {}).get("turn_id") or "")
    return ""


def material_event(row: dict[str, Any]) -> bool:
    payload = row.get("payload") or {}
    if row.get("type") == "event_msg":
        return payload.get("type") in {
            "user_message",
            "agent_reasoning",
            "agent_message",
            "token_count",
            "sub_agent_activity",
            "patch_apply_end",
            "task_complete",
        }
    if row.get("type") == "response_item":
        return payload.get("type") in {
            "message",
            "reasoning",
            "custom_tool_call",
            "custom_tool_call_output",
            "function_call",
            "function_call_output",
        }
    return False


def emit_material_row(emit, thread_id: str, turn_id: str, row: dict[str, Any], index: int, ts_ms: int) -> bool:
    payload = row.get("payload") or {}
    row_type = row.get("type")
    item_id_prefix = f"backfill:{index}"
    if row_type == "event_msg":
        kind = payload.get("type")
        if kind == "user_message":
            emit_item(emit, thread_id, turn_id, "userMessage", payload.get("client_id") or f"{item_id_prefix}:user", {"content": [{"type": "input_text", "text": payload.get("message") or ""}]}, ts_ms)
            return True
        if kind == "agent_reasoning":
            emit_item(emit, thread_id, turn_id, "reasoning", f"{item_id_prefix}:reasoning", {"summary": [payload.get("text") or ""], "content": []}, ts_ms)
            return True
        if kind == "agent_message":
            emit_item(emit, thread_id, turn_id, "agentMessage", f"{item_id_prefix}:agent", {"text": payload.get("message") or "", "phase": payload.get("phase") or ""}, ts_ms)
            return True
        if kind == "task_complete":
            emit_item(emit, thread_id, turn_id, "agentMessage", f"task-complete:{turn_id}", {"text": payload.get("last_agent_message") or "", "phase": "final_answer"}, ts_ms)
            return True
        if kind == "token_count":
            usage = payload.get("info") or {}
            emit(
                "thread/tokenUsage/updated",
                {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "tokenUsage": {
                        "total": token_totals(usage.get("total_token_usage") or {}),
                        "last": token_totals(usage.get("last_token_usage") or {}),
                        "modelContextWindow": usage.get("model_context_window") or 0,
                    },
                },
                ts_ms,
            )
            return True
        if kind == "sub_agent_activity":
            emit_item(
                emit,
                thread_id,
                turn_id,
                "subAgentActivity",
                payload.get("event_id") or f"{item_id_prefix}:subagent",
                {
                    "kind": payload.get("kind") or "",
                    "agentThreadId": payload.get("agent_thread_id") or "",
                    "agentPath": payload.get("agent_path") or "",
                },
                ts_ms,
            )
            return True
        if kind == "patch_apply_end":
            emit_item(
                emit,
                thread_id,
                turn_id,
                "fileChange",
                payload.get("call_id") or f"{item_id_prefix}:patch",
                {
                    "status": "completed" if payload.get("success") else "failed",
                    "changes": [{"path": key, "status": value} for key, value in (payload.get("changes") or {}).items()],
                },
                ts_ms,
            )
            return True
    if row_type == "response_item":
        item_type = payload.get("type")
        if item_type == "message":
            role = payload.get("role")
            text = content_text(payload.get("content") or [])
            if not text:
                return False
            if role == "assistant":
                emit_item(emit, thread_id, turn_id, "agentMessage", payload.get("id") or f"{item_id_prefix}:message", {"text": text, "phase": payload.get("phase") or ""}, ts_ms)
                return True
            if role == "user":
                emit_item(emit, thread_id, turn_id, "userMessage", payload.get("id") or f"{item_id_prefix}:message", {"content": [{"type": "input_text", "text": text}]}, ts_ms)
                return True
            return False
        if item_type == "reasoning":
            summary = []
            for part in payload.get("summary") or []:
                summary.append(part.get("text") if isinstance(part, dict) else str(part))
            if not summary:
                return False
            emit_item(emit, thread_id, turn_id, "reasoning", payload.get("id") or f"{item_id_prefix}:reasoning", {"summary": summary, "content": []}, ts_ms)
            return True
        if item_type in {"custom_tool_call", "function_call"}:
            call_id = payload.get("call_id") or payload.get("callId") or payload.get("id") or f"{item_id_prefix}:tool"
            emit_item(
                emit,
                thread_id,
                turn_id,
                "mcpToolCall",
                call_id,
                {
                    "status": payload.get("status") or "completed",
                    "server": "custom",
                    "tool": payload.get("name") or item_type,
                    "arguments": payload.get("input") or payload.get("arguments") or "",
                },
                ts_ms,
            )
            return True
        if item_type in {"custom_tool_call_output", "function_call_output"}:
            call_id = payload.get("call_id") or payload.get("callId") or f"{item_id_prefix}:tool-output"
            emit_item(
                emit,
                thread_id,
                turn_id,
                "mcpToolCall",
                call_id,
                {
                    "status": "completed",
                    "server": "custom",
                    "tool": item_type,
                    "result": content_text(payload.get("output") or []),
                },
                ts_ms,
            )
            return True
    return False


def emit_item(emit, thread_id: str, turn_id: str, item_type: str, item_id: str, fields: dict[str, Any], ts_ms: int) -> None:
    item = {"type": item_type, "id": str(item_id)}
    item.update(fields)
    emit("item/completed", {"threadId": thread_id, "turnId": turn_id, "item": item, "completedAtMs": ts_ms}, ts_ms)


def token_totals(value: dict[str, Any]) -> dict[str, int]:
    return {
        "totalTokens": int(value.get("total_tokens") or value.get("totalTokens") or 0),
        "inputTokens": int(value.get("input_tokens") or value.get("inputTokens") or 0),
        "cachedInputTokens": int(value.get("cached_input_tokens") or value.get("cachedInputTokens") or 0),
        "outputTokens": int(value.get("output_tokens") or value.get("outputTokens") or 0),
        "reasoningOutputTokens": int(value.get("reasoning_output_tokens") or value.get("reasoningOutputTokens") or 0),
    }


def content_text(parts: Any) -> str:
    if isinstance(parts, str):
        return parts
    if not isinstance(parts, list):
        return ""
    out: list[str] = []
    for part in parts:
        if isinstance(part, str):
            out.append(part)
        elif not isinstance(part, dict):
            continue
        elif part.get("type") in {"encrypted_content", "input_image"}:
            continue
        elif part.get("text"):
            out.append(str(part.get("text")))
        elif part.get("image_url"):
            out.append(f"[image] {truncate(str(part.get('image_url')), 200)}")
        else:
            compact = {key: value for key, value in part.items() if key not in {"encrypted_content", "image_url"}}
            if compact:
                out.append(json.dumps(compact, ensure_ascii=False))
    return "\n".join(text for text in out if text)


def timestamp_ms(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value if value > 10_000_000_000 else value * 1000)
    text = str(value)
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return 0


def iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def now_ms() -> int:
    return int(time.time() * 1000)


def truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[:limit] + "...(truncated)"


if __name__ == "__main__":
    raise SystemExit(main())
