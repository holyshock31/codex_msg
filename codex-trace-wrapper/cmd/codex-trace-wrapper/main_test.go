package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestPrepareRuntimeConfigFailsOpenOnConfigError(t *testing.T) {
	realCodex := writeFakeRealCodex(t)
	t.Setenv(configEnv, filepath.Join(t.TempDir(), "missing.toml"))
	t.Setenv(realCodexEnv, realCodex)

	cfg, traceEnabled, err := prepareRuntimeConfig(&bootstrapLog{})
	if err != nil {
		t.Fatalf("prepareRuntimeConfig returned error: %v", err)
	}
	if traceEnabled {
		t.Fatal("trace should be disabled after a config error")
	}
	if cfg.RealCodex != realCodex {
		t.Fatalf("real codex = %q, want %q", cfg.RealCodex, realCodex)
	}
	if cfg.DaemonURL != "" || cfg.FallbackNDJSON || cfg.ReasoningSummaryOverride != "" || cfg.EnableExperimentalRawEvents {
		t.Fatalf("passthrough config retained tracing behavior: %+v", cfg)
	}
}

func TestPrepareRuntimeConfigFailsOpenOnTraceDirectoryError(t *testing.T) {
	realCodex := writeFakeRealCodex(t)
	tracePath := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(tracePath, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(configEnv, "")
	t.Setenv(realCodexEnv, realCodex)
	t.Setenv(traceDirEnv, tracePath)
	t.Setenv(daemonURLEnv, "tcp://127.0.0.1:1")
	t.Setenv(fallbackNDJSONEnv, "true")
	t.Setenv(summaryOverrideEnv, "detailed")
	t.Setenv(rawEventsEnv, "true")

	cfg, traceEnabled, err := prepareRuntimeConfig(&bootstrapLog{})
	if err != nil {
		t.Fatalf("prepareRuntimeConfig returned error: %v", err)
	}
	if traceEnabled {
		t.Fatal("trace should be disabled when the trace directory cannot be created")
	}
	if cfg.RealCodex != realCodex {
		t.Fatalf("real codex = %q, want %q", cfg.RealCodex, realCodex)
	}
	if cfg.TraceDir != "" || cfg.DaemonURL != "" || cfg.FallbackNDJSON || cfg.ReasoningSummaryOverride != "" || cfg.EnableExperimentalRawEvents {
		t.Fatalf("passthrough config retained tracing behavior: %+v", cfg)
	}
}

func TestTraceSinkFallsBackToNDJSON(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}

	traceDir := t.TempDir()
	events := make(chan traceEvent, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go traceSink(&wg, events, config{
		TraceDir:       traceDir,
		DaemonURL:      "tcp://" + address,
		FallbackNDJSON: true,
	})
	events <- traceEvent{Seq: 7, TsMs: 8, Pid: 9, Dir: "server_to_client", Raw: `{"method":"turn/completed"}`}
	close(events)
	wg.Wait()

	file, err := os.Open(filepath.Join(traceDir, "events.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		t.Fatalf("fallback file is empty: %v", scanner.Err())
	}
	var event traceEvent
	if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event.Seq != 7 || event.Dir != "server_to_client" {
		t.Fatalf("unexpected fallback event: %+v", event)
	}
	healthBytes, err := os.ReadFile(filepath.Join(traceDir, "health.json"))
	if err != nil {
		t.Fatal(err)
	}
	var health struct {
		Dropped uint64 `json:"dropped_by_writer"`
	}
	if err := json.Unmarshal(healthBytes, &health); err != nil {
		t.Fatal(err)
	}
	if health.Dropped != 0 {
		t.Fatalf("fallback succeeded but health reported %d dropped event(s)", health.Dropped)
	}
}

func writeFakeRealCodex(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "codex.exe")
	if err := os.WriteFile(path, []byte("fake"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
