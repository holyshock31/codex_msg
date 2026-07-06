package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	realCodexEnv      = "CODEX_TRACE_REAL_CODEX"
	traceDirEnv       = "CODEX_TRACE_DIR"
	daemonURLEnv      = "CODEX_TRACE_DAEMON_URL"
	fallbackNDJSONEnv = "CODEX_TRACE_FALLBACK_NDJSON"
	queueCapacityEnv  = "CODEX_TRACE_QUEUE_CAPACITY"
	sourceEnv         = "CODEX_TRACE_SOURCE"
	sourceIDEnv       = "CODEX_TRACE_SOURCE_ID"
	transportEnv      = "CODEX_TRACE_TRANSPORT"
	connectionIDEnv   = "CODEX_TRACE_CONNECTION_ID"
	wsDebugEnv        = "CODEX_TRACE_WS_DEBUG"
	defaultQueueCap   = 10000
	maxWSMessageBytes = 16 * 1024 * 1024
)

type config struct {
	RealCodex      string
	TraceDir       string
	DaemonURL      string
	FallbackNDJSON bool
	QueueCapacity  int
	Source         string
	SourceID       string
	Transport      string
	ConnectionID   string
	WSDebug        bool
	ChildArgs      []string
}

type traceEvent struct {
	Schema       string `json:"schema,omitempty"`
	Seq          uint64 `json:"seq"`
	TsMs         int64  `json:"ts_ms"`
	Pid          int    `json:"pid"`
	Dir          string `json:"dir"`
	Raw          string `json:"raw"`
	Source       string `json:"source,omitempty"`
	SourceID     string `json:"source_id,omitempty"`
	Transport    string `json:"transport,omitempty"`
	ConnectionID string `json:"connection_id,omitempty"`
	Codec        string `json:"codec,omitempty"`
}

type eventEmitter struct {
	cfg     config
	events  chan<- traceEvent
	seq     *atomic.Uint64
	pid     int
	dropped *atomic.Uint64
}

func main() {
	code, err := run()
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "codex-proxy-trace error: %v\n", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func run() (int, error) {
	cfg, err := loadConfig(os.Args[1:])
	if err != nil {
		return 1, err
	}
	if err := os.MkdirAll(cfg.TraceDir, 0o700); err != nil {
		return 1, fmt.Errorf("create trace dir %s: %w", cfg.TraceDir, err)
	}

	cmd := exec.Command(cfg.RealCodex, cfg.ChildArgs...)
	childStdin, err := cmd.StdinPipe()
	if err != nil {
		return 1, fmt.Errorf("open child stdin: %w", err)
	}
	childStdout, err := cmd.StdoutPipe()
	if err != nil {
		return 1, fmt.Errorf("open child stdout: %w", err)
	}
	childStderr, err := cmd.StderrPipe()
	if err != nil {
		return 1, fmt.Errorf("open child stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("spawn real codex proxy %s: %w", cfg.RealCodex, err)
	}

	events := make(chan traceEvent, cfg.QueueCapacity)
	var writerWG sync.WaitGroup
	var dropped atomic.Uint64
	writerWG.Add(1)
	go traceSink(&writerWG, events, cfg, &dropped)

	var seq atomic.Uint64
	seq.Store(1)
	emitter := &eventEmitter{
		cfg:     cfg,
		events:  events,
		seq:     &seq,
		pid:     cmd.Process.Pid,
		dropped: &dropped,
	}
	emitter.status("process_start", map[string]any{
		"real_codex": cfg.RealCodex,
		"args":       cfg.ChildArgs,
	})

	clientParser := newHTTPThenWSParser("client_to_server", emitter)
	serverParser := newHTTPThenWSParser("server_to_client", emitter)

	var pipeWG sync.WaitGroup
	pipeWG.Add(3)
	go func() {
		defer pipeWG.Done()
		_ = pipeBytes(os.Stdin, childStdin, clientParser)
		_ = childStdin.Close()
	}()
	go func() {
		defer pipeWG.Done()
		_ = pipeBytes(childStdout, os.Stdout, serverParser)
	}()
	go func() {
		defer pipeWG.Done()
		_ = pipeStderr(childStderr, os.Stderr, emitter)
	}()

	waitErr := cmd.Wait()
	pipeWG.Wait()

	exitCode := 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}
	emitter.status("process_exit", map[string]any{
		"exit_code":        exitCode,
		"dropped_by_queue": dropped.Load(),
	})
	close(events)
	writerWG.Wait()

	if waitErr == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 1, waitErr
}

func loadConfig(args []string) (config, error) {
	cfg := config{
		QueueCapacity: defaultQueueCap,
		DaemonURL:     "tcp://127.0.0.1:45124",
		Source:        "remote",
		Transport:     "ssh-proxy-websocket",
	}
	remaining := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--real-codex":
			i++
			if i >= len(args) {
				return cfg, errors.New("--real-codex requires a value")
			}
			cfg.RealCodex = args[i]
		case strings.HasPrefix(arg, "--real-codex="):
			cfg.RealCodex = strings.TrimPrefix(arg, "--real-codex=")
		case arg == "--":
			remaining = append(remaining, args[i+1:]...)
			i = len(args)
		default:
			remaining = append(remaining, arg)
		}
	}
	if value := strings.TrimSpace(os.Getenv(realCodexEnv)); cfg.RealCodex == "" && value != "" {
		cfg.RealCodex = value
	}
	if cfg.RealCodex == "" {
		cfg.RealCodex = "codex"
	}
	cfg.ChildArgs = remaining
	if len(cfg.ChildArgs) == 0 {
		cfg.ChildArgs = []string{"app-server", "proxy"}
	}

	if value := strings.TrimSpace(os.Getenv(traceDirEnv)); value != "" {
		cfg.TraceDir = value
	}
	if cfg.TraceDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return cfg, fmt.Errorf("resolve user home: %w", err)
		}
		cfg.TraceDir = filepath.Join(home, ".local", "codex_trace", "log")
	}
	if value := strings.TrimSpace(os.Getenv(daemonURLEnv)); value != "" {
		cfg.DaemonURL = value
	}
	if value := strings.TrimSpace(os.Getenv(fallbackNDJSONEnv)); value != "" {
		cfg.FallbackNDJSON = parseBool(value)
	}
	if value := strings.TrimSpace(os.Getenv(queueCapacityEnv)); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
			cfg.QueueCapacity = parsed
		}
	}
	if value := strings.TrimSpace(os.Getenv(sourceEnv)); value != "" {
		cfg.Source = value
	}
	if value := strings.TrimSpace(os.Getenv(transportEnv)); value != "" {
		cfg.Transport = value
	}
	if value := strings.TrimSpace(os.Getenv(sourceIDEnv)); value != "" {
		cfg.SourceID = value
	}
	if value := strings.TrimSpace(os.Getenv(connectionIDEnv)); value != "" {
		cfg.ConnectionID = value
	}
	if value := strings.TrimSpace(os.Getenv(wsDebugEnv)); value != "" {
		cfg.WSDebug = parseBool(value)
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "unknown-host"
	}
	if cfg.SourceID == "" {
		cfg.SourceID = fmt.Sprintf("ssh:%s:%d", host, os.Getpid())
	}
	if cfg.ConnectionID == "" {
		cfg.ConnectionID = fmt.Sprintf("%s-%d-%d", host, os.Getpid(), nowMs())
	}
	if cfg.QueueCapacity <= 0 {
		cfg.QueueCapacity = defaultQueueCap
	}
	return cfg, nil
}

func parseBool(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on", "enabled":
		return true
	default:
		return false
	}
}

func pipeBytes(r io.Reader, w io.Writer, parser *httpThenWSParser) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			parser.Feed(chunk)
			if writeErr := writeAll(w, chunk); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func pipeStderr(r io.Reader, w io.Writer, emitter *eventEmitter) error {
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			_ = writeAll(w, line)
			emitter.emit("server_stderr", strings.TrimRight(string(line), "\r\n"), "stderr")
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

func (e *eventEmitter) emit(dir, raw, codec string) {
	event := traceEvent{
		Schema:       "codex.trace.event.v1",
		Seq:          e.seq.Add(1) - 1,
		TsMs:         nowMs(),
		Pid:          e.pid,
		Dir:          dir,
		Raw:          raw,
		Source:       e.cfg.Source,
		SourceID:     e.cfg.SourceID,
		Transport:    e.cfg.Transport,
		ConnectionID: e.cfg.ConnectionID,
		Codec:        codec,
	}
	select {
	case e.events <- event:
	default:
		e.dropped.Add(1)
	}
}

func (e *eventEmitter) emitJSONRPC(dir string, payload []byte) {
	trimmed := bytes.TrimSpace(payload)
	if !json.Valid(trimmed) {
		if e.cfg.WSDebug {
			e.status("jsonrpc_skip_invalid", map[string]any{
				"dir":   dir,
				"bytes": len(payload),
			})
		}
		return
	}
	e.emit(dir, string(trimmed), "websocket-jsonrpc")
}

func (e *eventEmitter) status(phase string, fields map[string]any) {
	params := map[string]any{
		"source":        e.cfg.Source,
		"source_id":     e.cfg.SourceID,
		"transport":     e.cfg.Transport,
		"connection_id": e.cfg.ConnectionID,
		"phase":         phase,
	}
	for key, value := range fields {
		params[key] = value
	}
	raw, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "trace/status",
		"params":  params,
	})
	if err != nil {
		return
	}
	e.emit("trace_status", string(raw), "trace-status")
}

type httpThenWSParser struct {
	dir        string
	emitter    *eventEmitter
	headerDone bool
	header     []byte
	ws         *wsFrameParser
}

func newHTTPThenWSParser(dir string, emitter *eventEmitter) *httpThenWSParser {
	return &httpThenWSParser{
		dir:     dir,
		emitter: emitter,
		ws:      newWSFrameParser(dir, emitter),
	}
}

func (p *httpThenWSParser) Feed(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	if p.headerDone {
		p.ws.Feed(chunk)
		return
	}
	p.header = append(p.header, chunk...)
	headerEnd, delimiterLen := findHeaderEnd(p.header)
	if headerEnd < 0 {
		if len(p.header) > 64*1024 {
			p.emitter.status("http_header_too_large", map[string]any{
				"dir":   p.dir,
				"bytes": len(p.header),
			})
			p.header = p.header[:0]
		}
		return
	}
	headerBytes := append([]byte(nil), p.header[:headerEnd+delimiterLen]...)
	rest := append([]byte(nil), p.header[headerEnd+delimiterLen:]...)
	p.header = nil
	p.headerDone = true
	p.emitter.status("websocket_http_upgrade", map[string]any{
		"dir":        p.dir,
		"header_len": len(headerBytes),
		"status":     firstHeaderLine(headerBytes),
	})
	if len(rest) > 0 {
		p.ws.Feed(rest)
	}
}

func findHeaderEnd(data []byte) (int, int) {
	if idx := bytes.Index(data, []byte("\r\n\r\n")); idx >= 0 {
		return idx, 4
	}
	if idx := bytes.Index(data, []byte("\n\n")); idx >= 0 {
		return idx, 2
	}
	return -1, 0
}

func firstHeaderLine(header []byte) string {
	line := header
	if idx := bytes.IndexByte(header, '\n'); idx >= 0 {
		line = header[:idx]
	}
	return strings.TrimSpace(string(line))
}

type wsFrameParser struct {
	dir            string
	emitter        *eventEmitter
	buf            []byte
	fragmented     bool
	fragmentRSV1   bool
	fragmentOpcode byte
	fragment       []byte
}

func newWSFrameParser(dir string, emitter *eventEmitter) *wsFrameParser {
	return &wsFrameParser{dir: dir, emitter: emitter}
}

func (p *wsFrameParser) Feed(chunk []byte) {
	p.buf = append(p.buf, chunk...)
	for {
		if !p.consumeOne() {
			return
		}
	}
}

func (p *wsFrameParser) consumeOne() bool {
	if len(p.buf) < 2 {
		return false
	}
	b0 := p.buf[0]
	b1 := p.buf[1]
	fin := b0&0x80 != 0
	rsv1 := b0&0x40 != 0
	opcode := b0 & 0x0f
	masked := b1&0x80 != 0
	payloadLen := uint64(b1 & 0x7f)
	offset := 2
	if payloadLen == 126 {
		if len(p.buf) < offset+2 {
			return false
		}
		payloadLen = uint64(binary.BigEndian.Uint16(p.buf[offset : offset+2]))
		offset += 2
	} else if payloadLen == 127 {
		if len(p.buf) < offset+8 {
			return false
		}
		payloadLen = binary.BigEndian.Uint64(p.buf[offset : offset+8])
		offset += 8
	}
	if payloadLen > maxWSMessageBytes {
		p.emitter.status("websocket_payload_too_large", map[string]any{
			"dir":          p.dir,
			"payload_len":  payloadLen,
			"max_payload":  maxWSMessageBytes,
			"frame_opcode": opcode,
		})
		p.buf = nil
		p.fragment = nil
		p.fragmented = false
		return false
	}
	var maskKey []byte
	if masked {
		if len(p.buf) < offset+4 {
			return false
		}
		maskKey = p.buf[offset : offset+4]
		offset += 4
	}
	total := offset + int(payloadLen)
	if len(p.buf) < total {
		return false
	}
	payload := append([]byte(nil), p.buf[offset:total]...)
	p.buf = p.buf[total:]
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	p.handleFrame(fin, rsv1, opcode, payload)
	return true
}

func (p *wsFrameParser) handleFrame(fin bool, rsv1 bool, opcode byte, payload []byte) {
	switch opcode {
	case 0x1:
		if rsv1 {
			p.emitter.status("websocket_text_compressed_skip", map[string]any{
				"dir":   p.dir,
				"bytes": len(payload),
			})
			return
		}
		if fin {
			p.emitter.emitJSONRPC(p.dir, payload)
			return
		}
		p.fragmented = true
		p.fragmentRSV1 = false
		p.fragmentOpcode = opcode
		p.fragment = append(p.fragment[:0], payload...)
	case 0x0:
		if !p.fragmented {
			return
		}
		if len(p.fragment)+len(payload) > maxWSMessageBytes {
			p.emitter.status("websocket_fragment_too_large", map[string]any{
				"dir": p.dir,
			})
			p.fragment = nil
			p.fragmented = false
			return
		}
		p.fragment = append(p.fragment, payload...)
		if fin {
			if p.fragmentOpcode == 0x1 && !p.fragmentRSV1 {
				p.emitter.emitJSONRPC(p.dir, p.fragment)
			}
			p.fragment = nil
			p.fragmented = false
		}
	case 0x2, 0x8, 0x9, 0xA:
		return
	default:
		if p.emitter.cfg.WSDebug {
			p.emitter.status("websocket_opcode_skip", map[string]any{
				"dir":    p.dir,
				"opcode": opcode,
				"bytes":  len(payload),
			})
		}
	}
}

func traceSink(wg *sync.WaitGroup, events <-chan traceEvent, cfg config, droppedByQueue *atomic.Uint64) {
	defer wg.Done()

	healthPath := filepath.Join(cfg.TraceDir, "health.json")
	var daemon traceEventSink
	if cfg.DaemonURL != "" {
		daemon = newDaemonSink(cfg.DaemonURL)
	}
	var fallback traceEventSink
	var fallbackErr error
	if cfg.FallbackNDJSON {
		fallback, fallbackErr = newNDJSONSink(filepath.Join(cfg.TraceDir, "events.ndjson"))
	}
	if daemon == nil && fallback == nil {
		writeHealth(healthPath, 0, 0, droppedByQueue.Load(), 0, fmt.Sprintf("trace sink disabled or unavailable: %v", fallbackErr))
		for range events {
		}
		return
	}
	defer func() {
		if daemon != nil {
			_ = daemon.Close()
		}
		if fallback != nil {
			_ = fallback.Close()
		}
	}()

	var written uint64
	var lastSeq uint64
	var failed uint64
	for event := range events {
		wrote := false
		if daemon != nil {
			if err := daemon.Write(event); err == nil {
				wrote = true
			} else {
				failed++
			}
		}
		if !wrote && fallback != nil {
			if err := fallback.Write(event); err == nil {
				wrote = true
			} else {
				failed++
			}
		}
		if wrote {
			written++
			lastSeq = event.Seq
		}
		if (written+failed)%50 == 0 {
			flushSink(daemon)
			flushSink(fallback)
			writeHealth(healthPath, written, lastSeq, droppedByQueue.Load(), failed, "")
		}
	}
	flushSink(daemon)
	flushSink(fallback)
	writeHealth(healthPath, written, lastSeq, droppedByQueue.Load(), failed, "")
}

func flushSink(sink traceEventSink) {
	if sink != nil {
		_ = sink.Flush()
	}
}

type traceEventSink interface {
	Write(traceEvent) error
	Flush() error
	Close() error
}

type ndjsonSink struct {
	file   *os.File
	writer *bufio.Writer
}

func newNDJSONSink(eventsPath string) (*ndjsonSink, error) {
	file, err := openAppend(eventsPath)
	if err != nil {
		return nil, err
	}
	return &ndjsonSink{file: file, writer: bufio.NewWriter(file)}, nil
}

func (s *ndjsonSink) Write(event traceEvent) error {
	encoded, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := s.writer.Write(encoded); err != nil {
		return err
	}
	return s.writer.WriteByte('\n')
}

func (s *ndjsonSink) Flush() error {
	return s.writer.Flush()
}

func (s *ndjsonSink) Close() error {
	_ = s.writer.Flush()
	return s.file.Close()
}

type daemonSink struct {
	url      string
	network  string
	address  string
	conn     net.Conn
	nextDial time.Time
}

func newDaemonSink(url string) *daemonSink {
	network, address, ok := strings.Cut(url, "://")
	if !ok {
		network = "tcp"
		address = url
	}
	if network != "tcp" {
		return &daemonSink{url: url}
	}
	return &daemonSink{url: url, network: network, address: address}
}

func (s *daemonSink) Write(event traceEvent) error {
	if s.network == "" {
		return fmt.Errorf("unsupported daemon_url %q", s.url)
	}
	if s.conn == nil {
		if time.Now().Before(s.nextDial) {
			return errors.New("daemon disconnected")
		}
		conn, err := net.DialTimeout(s.network, s.address, 300*time.Millisecond)
		if err != nil {
			s.nextDial = time.Now().Add(time.Second)
			return err
		}
		s.conn = conn
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return err
	}
	payload := append(encoded, '\n')
	_ = s.conn.SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
	if _, err := s.conn.Write(payload); err != nil {
		_ = s.conn.Close()
		s.conn = nil
		s.nextDial = time.Now().Add(time.Second)
		return err
	}
	return nil
}

func (s *daemonSink) Flush() error {
	return nil
}

func (s *daemonSink) Close() error {
	if s.conn == nil {
		return nil
	}
	return s.conn.Close()
}

func writeHealth(path string, written, lastSeq, droppedByQueue, failed uint64, errText string) {
	payload := map[string]any{
		"ts_ms":             nowMs(),
		"written":           written,
		"last_seq":          lastSeq,
		"dropped_by_queue":  droppedByQueue,
		"dropped_by_writer": failed,
		"error":             nil,
	}
	if errText != "" {
		payload["error"] = errText
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, append(encoded, '\n'), 0o600)
}

func openAppend(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

func nowMs() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}
