package main

import (
	"encoding/binary"
	"encoding/json"
	"sync/atomic"
	"testing"
)

func TestLoadConfigUsesRemoteForwardPortByDefault(t *testing.T) {
	t.Setenv(daemonURLEnv, "")
	cfg, err := loadConfig(nil)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.DaemonURL != "tcp://127.0.0.1:45125" {
		t.Fatalf("DaemonURL = %q, want remote forward port 45125", cfg.DaemonURL)
	}
}

func TestHTTPThenWSParserEmitsJSONRPC(t *testing.T) {
	events := make(chan traceEvent, 10)
	var seq atomic.Uint64
	seq.Store(1)
	var dropped atomic.Uint64
	emitter := &eventEmitter{
		cfg: config{
			Source:       "remote",
			SourceID:     "ssh:test:1",
			Transport:    "ssh-proxy-websocket",
			ConnectionID: "test-connection",
		},
		events:  events,
		seq:     &seq,
		pid:     123,
		dropped: &dropped,
	}

	parser := newHTTPThenWSParser("client_to_server", emitter)
	parser.Feed([]byte("GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n"))
	parser.Feed(maskedTextFrame(`{"jsonrpc":"2.0","id":1,"method":"thread/list","params":{"threadId":"remote-thread"}}`))
	close(events)

	var found bool
	for event := range events {
		if event.Dir != "client_to_server" {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(event.Raw), &raw); err != nil {
			t.Fatalf("raw event is not JSON: %v", err)
		}
		if raw["method"] == "thread/list" && event.SourceID == "ssh:test:1" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected decoded client_to_server JSON-RPC event")
	}
}

func maskedTextFrame(text string) []byte {
	payload := []byte(text)
	mask := []byte{0x11, 0x22, 0x33, 0x44}
	header := []byte{0x81}
	if len(payload) < 126 {
		header = append(header, byte(0x80|len(payload)))
	} else {
		header = append(header, 0xFE, 0, 0)
		binary.BigEndian.PutUint16(header[len(header)-2:], uint16(len(payload)))
	}
	header = append(header, mask...)
	for i, b := range payload {
		header = append(header, b^mask[i%len(mask)])
	}
	return header
}
