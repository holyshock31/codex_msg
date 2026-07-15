package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	configEnv          = "CODEX_TRACE_WRAPPER_CONFIG"
	realCodexEnv       = "CODEX_TRACE_REAL_CODEX"
	traceDirEnv        = "CODEX_TRACE_DIR"
	daemonURLEnv       = "CODEX_TRACE_DAEMON_URL"
	fallbackNDJSONEnv  = "CODEX_TRACE_FALLBACK_NDJSON"
	queueCapacityEnv   = "CODEX_TRACE_QUEUE_CAPACITY"
	summaryOverrideEnv = "CODEX_TRACE_REASONING_SUMMARY_OVERRIDE"
	rawEventsEnv       = "CODEX_TRACE_ENABLE_EXPERIMENTAL_RAW_EVENTS"
	defaultQueueCap    = 10000
)

type config struct {
	RealCodex                   string
	TraceDir                    string
	DaemonURL                   string
	FallbackNDJSON              bool
	QueueCapacity               int
	ReasoningSummaryOverride    string
	EnableExperimentalRawEvents bool
}

type traceEvent struct {
	Seq  uint64 `json:"seq"`
	TsMs int64  `json:"ts_ms"`
	Pid  int    `json:"pid"`
	Dir  string `json:"dir"`
	Raw  string `json:"raw"`
}

func main() {
	writeEarlyMarker()
	bootstrap := openBootstrapLog()
	defer bootstrap.Close()
	bootstrap.Log("process_start", map[string]string{
		"pid":                    strconv.Itoa(os.Getpid()),
		"ppid":                   strconv.Itoa(os.Getppid()),
		"exe":                    executablePath(),
		"cwd":                    workingDir(),
		"args":                   strings.Join(os.Args, "\x1f"),
		"user":                   currentUserText(),
		configEnv:                os.Getenv(configEnv),
		realCodexEnv:             os.Getenv(realCodexEnv),
		traceDirEnv:              os.Getenv(traceDirEnv),
		daemonURLEnv:             os.Getenv(daemonURLEnv),
		fallbackNDJSONEnv:        os.Getenv(fallbackNDJSONEnv),
		queueCapacityEnv:         os.Getenv(queueCapacityEnv),
		summaryOverrideEnv:       os.Getenv(summaryOverrideEnv),
		rawEventsEnv:             os.Getenv(rawEventsEnv),
		"LOCALAPPDATA":           os.Getenv("LOCALAPPDATA"),
		"USERPROFILE":            os.Getenv("USERPROFILE"),
		"TEMP":                   os.Getenv("TEMP"),
		"TMP":                    os.Getenv("TMP"),
		"PROCESSOR_ARCHITECTURE": os.Getenv("PROCESSOR_ARCHITECTURE"),
	})

	code, err := run(bootstrap)
	if err != nil {
		bootstrap.Log("process_error", map[string]string{"error": err.Error()})
		_, _ = fmt.Fprintf(os.Stderr, "codex-trace-wrapper error: %v\n", err)
		os.Exit(1)
	}
	bootstrap.Log("process_exit", map[string]string{"code": strconv.Itoa(code)})
	os.Exit(code)
}

func writeEarlyMarker() {
	paths := []string{
		filepath.Join(os.Getenv("USERPROFILE"), ".codex-trace", "bootstrap-start.txt"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "CodexTrace", "bootstrap-start.txt"),
		filepath.Join(os.TempDir(), "CodexTrace", "bootstrap-start.txt"),
	}
	line := fmt.Sprintf("%d pid=%d ppid=%d exe=%s args=%s\n", nowMs(), os.Getpid(), os.Getppid(), executablePath(), strings.Join(os.Args, "\x1f"))
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			continue
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			continue
		}
		_, _ = file.WriteString(line)
		_ = file.Close()
		return
	}
}

func run(bootstrap *bootstrapLog) (int, error) {
	cfg, traceEnabled, err := prepareRuntimeConfig(bootstrap)
	if err != nil {
		return 1, err
	}

	if traceEnabled {
		wrapperLogPath := filepath.Join(cfg.TraceDir, "wrapper.log")
		bootstrap.Log("wrapper_log_open_start", map[string]string{"path": wrapperLogPath})
		logFile, logErr := openAppend(wrapperLogPath)
		if logErr == nil {
			_, _ = fmt.Fprintf(logFile, "%d starting real_codex=%s trace_dir=%s daemon_url=%s fallback_ndjson=%t queue_capacity=%d summary_override=%s raw_events=%t\n", nowMs(), cfg.RealCodex, cfg.TraceDir, cfg.DaemonURL, cfg.FallbackNDJSON, cfg.QueueCapacity, cfg.ReasoningSummaryOverride, cfg.EnableExperimentalRawEvents)
			_ = logFile.Close()
			bootstrap.Log("wrapper_log_open_done", map[string]string{"path": wrapperLogPath})
		} else {
			bootstrap.Log("wrapper_log_open_error", map[string]string{"path": wrapperLogPath, "error": logErr.Error()})
		}
	}

	bootstrap.Log("real_codex_command_prepare", map[string]string{
		"real_codex": cfg.RealCodex,
		"args":       strings.Join(os.Args[1:], "\x1f"),
	})
	cmd := exec.Command(cfg.RealCodex, os.Args[1:]...)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	bootstrap.Log("child_stdin_pipe_start", nil)
	childStdin, err := cmd.StdinPipe()
	if err != nil {
		bootstrap.Log("child_stdin_pipe_error", map[string]string{"error": err.Error()})
		return 1, fmt.Errorf("open child stdin: %w", err)
	}
	bootstrap.Log("child_stdout_pipe_start", nil)
	childStdout, err := cmd.StdoutPipe()
	if err != nil {
		bootstrap.Log("child_stdout_pipe_error", map[string]string{"error": err.Error()})
		return 1, fmt.Errorf("open child stdout: %w", err)
	}
	bootstrap.Log("child_stderr_pipe_start", nil)
	childStderr, err := cmd.StderrPipe()
	if err != nil {
		bootstrap.Log("child_stderr_pipe_error", map[string]string{"error": err.Error()})
		return 1, fmt.Errorf("open child stderr: %w", err)
	}

	bootstrap.Log("real_codex_spawn_start", map[string]string{"real_codex": cfg.RealCodex})
	if err := cmd.Start(); err != nil {
		bootstrap.Log("real_codex_spawn_error", map[string]string{"real_codex": cfg.RealCodex, "error": err.Error()})
		return 1, fmt.Errorf("spawn real codex %s: %w", cfg.RealCodex, err)
	}
	bootstrap.Log("real_codex_spawn_done", map[string]string{
		"real_codex": cfg.RealCodex,
		"child_pid":  strconv.Itoa(cmd.Process.Pid),
	})

	var events chan traceEvent
	var writerWG sync.WaitGroup
	if traceEnabled {
		events = make(chan traceEvent, cfg.QueueCapacity)
		writerWG.Add(1)
		go traceSink(&writerWG, events, cfg)
	}

	var seq atomic.Uint64
	seq.Store(1)
	var pipeWG sync.WaitGroup
	pid := cmd.Process.Pid

	pipeWG.Add(3)
	go func() {
		defer pipeWG.Done()
		_ = pipeLines(os.Stdin, childStdin, "client_to_server", pid, &seq, events, cfg)
		_ = childStdin.Close()
	}()
	go func() {
		defer pipeWG.Done()
		_ = pipeLines(childStdout, os.Stdout, "server_to_client", pid, &seq, events, cfg)
	}()
	go func() {
		defer pipeWG.Done()
		_ = pipeLines(childStderr, os.Stderr, "server_stderr", pid, &seq, events, cfg)
	}()

	bootstrap.Log("real_codex_wait_start", map[string]string{"child_pid": strconv.Itoa(cmd.Process.Pid)})
	waitErr := cmd.Wait()
	if waitErr != nil {
		bootstrap.Log("real_codex_wait_error", map[string]string{"child_pid": strconv.Itoa(cmd.Process.Pid), "error": waitErr.Error()})
	} else {
		bootstrap.Log("real_codex_wait_done", map[string]string{"child_pid": strconv.Itoa(cmd.Process.Pid)})
	}
	pipeWG.Wait()
	if events != nil {
		close(events)
		writerWG.Wait()
	}

	if waitErr == nil {
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	return 1, waitErr
}

func prepareRuntimeConfig(bootstrap *bootstrapLog) (config, bool, error) {
	bootstrap.Log("load_config_start", map[string]string{configEnv: os.Getenv(configEnv)})
	cfg, err := loadConfig()
	if err != nil {
		bootstrap.Log("load_config_error", map[string]string{"error": err.Error()})
		return failOpenConfig(bootstrap, cfg, err)
	}
	bootstrap.Log("load_config_done", map[string]string{
		"real_codex":       cfg.RealCodex,
		"trace_dir":        cfg.TraceDir,
		"daemon_url":       cfg.DaemonURL,
		"fallback_ndjson":  strconv.FormatBool(cfg.FallbackNDJSON),
		"queue_capacity":   strconv.Itoa(cfg.QueueCapacity),
		"summary_override": cfg.ReasoningSummaryOverride,
		"raw_events":       strconv.FormatBool(cfg.EnableExperimentalRawEvents),
	})

	bootstrap.Log("mkdir_trace_dir_start", map[string]string{"trace_dir": cfg.TraceDir})
	if err := os.MkdirAll(cfg.TraceDir, 0o700); err != nil {
		bootstrap.Log("mkdir_trace_dir_error", map[string]string{"trace_dir": cfg.TraceDir, "error": err.Error()})
		return failOpenConfig(bootstrap, cfg, fmt.Errorf("create trace dir %s: %w", cfg.TraceDir, err))
	}
	bootstrap.Log("mkdir_trace_dir_done", map[string]string{"trace_dir": cfg.TraceDir})
	return cfg, true, nil
}

func failOpenConfig(bootstrap *bootstrapLog, partial config, traceErr error) (config, bool, error) {
	cfg, err := loadPassthroughConfig(partial)
	if err != nil {
		return config{}, false, fmt.Errorf("trace setup failed (%v), and real codex could not be resolved: %w", traceErr, err)
	}
	reason := traceErr.Error()
	bootstrap.Log("trace_disabled_fail_open", map[string]string{"error": reason, "real_codex": cfg.RealCodex})
	_, _ = fmt.Fprintf(os.Stderr, "codex-trace-wrapper warning: trace disabled; continuing with real Codex: %v\n", traceErr)
	return cfg, false, nil
}

type bootstrapLog struct {
	mu   sync.Mutex
	file *os.File
	path string
}

func openBootstrapLog() *bootstrapLog {
	log := &bootstrapLog{}
	for _, path := range bootstrapLogPaths() {
		if path == "" {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			continue
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			continue
		}
		log.path = path
		log.file = file
		return log
	}
	return log
}

func bootstrapLogPaths() []string {
	var paths []string
	if dir := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); dir != "" {
		paths = append(paths, filepath.Join(dir, "CodexTrace", "bootstrap.log"))
	}
	if dir := strings.TrimSpace(os.Getenv("TEMP")); dir != "" {
		paths = append(paths, filepath.Join(dir, "CodexTrace", "bootstrap.log"))
	}
	if dir := strings.TrimSpace(os.Getenv("TMP")); dir != "" {
		paths = append(paths, filepath.Join(dir, "CodexTrace", "bootstrap.log"))
	}
	if dir := strings.TrimSpace(os.Getenv("USERPROFILE")); dir != "" {
		paths = append(paths, filepath.Join(dir, "AppData", "Local", "CodexTrace", "bootstrap.log"))
		paths = append(paths, filepath.Join(dir, ".codex-trace", "bootstrap.log"))
	}
	if dir := strings.TrimSpace(os.TempDir()); dir != "" {
		paths = append(paths, filepath.Join(dir, "CodexTrace", "bootstrap.log"))
	}
	return paths
}

func (l *bootstrapLog) Log(stage string, fields map[string]string) {
	if l == nil || l.file == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	record := map[string]any{
		"ts_ms": nowMs(),
		"stage": stage,
		"path":  l.path,
	}
	for key, value := range fields {
		record[key] = value
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return
	}
	_, _ = l.file.Write(append(encoded, '\n'))
	_ = l.file.Sync()
}

func (l *bootstrapLog) Close() {
	if l == nil || l.file == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.file.Close()
	l.file = nil
}

func executablePath() string {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Sprintf("error:%v", err)
	}
	return exe
}

func workingDir() string {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Sprintf("error:%v", err)
	}
	return cwd
}

func currentUserText() string {
	domain := strings.TrimSpace(os.Getenv("USERDOMAIN"))
	user := strings.TrimSpace(os.Getenv("USERNAME"))
	if domain != "" && user != "" {
		return domain + `\` + user
	}
	if user != "" {
		return user
	}
	return ""
}

func loadConfig() (config, error) {
	cfg := config{QueueCapacity: defaultQueueCap}

	if path := os.Getenv(configEnv); strings.TrimSpace(path) != "" {
		fileCfg, err := parseConfig(path)
		if err != nil {
			return cfg, err
		}
		cfg = mergeConfig(cfg, fileCfg)
	}

	if value := strings.TrimSpace(os.Getenv(realCodexEnv)); value != "" {
		cfg.RealCodex = value
	}
	if value := strings.TrimSpace(os.Getenv(traceDirEnv)); value != "" {
		cfg.TraceDir = value
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
	if value := strings.TrimSpace(os.Getenv(summaryOverrideEnv)); value != "" {
		cfg.ReasoningSummaryOverride = normalizeReasoningSummaryOverride(value)
	}
	if value := strings.TrimSpace(os.Getenv(rawEventsEnv)); value != "" {
		cfg.EnableExperimentalRawEvents = parseBool(value)
	}

	if cfg.RealCodex == "" {
		discovered, err := discoverRealCodex()
		if err != nil {
			return cfg, fmt.Errorf("real codex path not configured; set %s or %s: %w", realCodexEnv, configEnv, err)
		}
		cfg.RealCodex = discovered
	}
	if cfg.TraceDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return cfg, fmt.Errorf("resolve user home: %w", err)
		}
		cfg.TraceDir = filepath.Join(home, ".codex-trace")
	}

	if err := validateRealCodex(cfg.RealCodex); err != nil {
		return cfg, err
	}
	if cfg.QueueCapacity <= 0 {
		cfg.QueueCapacity = defaultQueueCap
	}
	if cfg.ReasoningSummaryOverride != "" && !validReasoningSummaryOverride(cfg.ReasoningSummaryOverride) {
		return cfg, fmt.Errorf("invalid reasoning_summary_override %q; expected auto, concise, detailed, or none", cfg.ReasoningSummaryOverride)
	}
	return cfg, nil
}

func loadPassthroughConfig(partial config) (config, error) {
	candidates := []string{
		strings.TrimSpace(os.Getenv(realCodexEnv)),
		strings.TrimSpace(partial.RealCodex),
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if err := validateRealCodex(candidate); err == nil {
			return config{RealCodex: candidate, QueueCapacity: defaultQueueCap}, nil
		}
	}

	discovered, err := discoverRealCodex()
	if err != nil {
		return config{}, err
	}
	if err := validateRealCodex(discovered); err != nil {
		return config{}, err
	}
	return config{RealCodex: discovered, QueueCapacity: defaultQueueCap}, nil
}

func validateRealCodex(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("real codex path is not accessible: %s: %w", path, err)
	}
	if info.IsDir() {
		return fmt.Errorf("real codex path is a directory: %s", path)
	}
	return nil
}

func mergeConfig(base, override config) config {
	if override.RealCodex != "" {
		base.RealCodex = override.RealCodex
	}
	if override.TraceDir != "" {
		base.TraceDir = override.TraceDir
	}
	if override.DaemonURL != "" {
		base.DaemonURL = override.DaemonURL
	}
	base.FallbackNDJSON = override.FallbackNDJSON
	if override.QueueCapacity > 0 {
		base.QueueCapacity = override.QueueCapacity
	}
	if override.ReasoningSummaryOverride != "" {
		base.ReasoningSummaryOverride = override.ReasoningSummaryOverride
	}
	if override.EnableExperimentalRawEvents {
		base.EnableExperimentalRawEvents = true
	}
	return base
}

func parseConfig(path string) (config, error) {
	var cfg config
	content, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read config %s: %w", path, err)
	}
	scanner := bufio.NewScanner(bytes.NewReader(content))
	section := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		key = strings.TrimPrefix(key, "\uFEFF")
		if section != "" && !strings.Contains(key, ".") {
			key = section + "." + key
		}
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		value = strings.ReplaceAll(value, `\\`, `\`)

		switch key {
		case "real_codex":
			cfg.RealCodex = value
		case "trace_dir":
			cfg.TraceDir = value
		case "daemon_url":
			cfg.DaemonURL = value
		case "fallback_ndjson":
			cfg.FallbackNDJSON = parseBool(value)
		case "queue_capacity":
			if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
				cfg.QueueCapacity = parsed
			}
		case "reasoning_summary_override":
			cfg.ReasoningSummaryOverride = normalizeReasoningSummaryOverride(value)
		case "rewrite.enable_experimental_raw_events", "enable_experimental_raw_events":
			cfg.EnableExperimentalRawEvents = parseBool(value)
		}
	}
	if err := scanner.Err(); err != nil {
		return cfg, fmt.Errorf("scan config %s: %w", path, err)
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

func discoverRealCodex() (string, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return "", errors.New("LOCALAPPDATA is empty")
	}
	root := filepath.Join(localAppData, "OpenAI", "Codex", "bin")
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	type candidate struct {
		path    string
		modTime time.Time
	}
	var candidates []candidate
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name(), "codex.exe")
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		candidates = append(candidates, candidate{path: path, modTime: info.ModTime()})
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("no codex.exe found under %s", root)
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].modTime.Before(candidates[j].modTime)
	})
	return candidates[len(candidates)-1].path, nil
}

func pipeLines(r io.Reader, w io.Writer, dir string, pid int, seq *atomic.Uint64, events chan<- traceEvent, cfg config) error {
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			outLine := maybeRewriteClientToServerLine(line, dir, cfg)
			if _, writeErr := w.Write(outLine); writeErr != nil {
				return writeErr
			}
			if flusher, ok := w.(interface{ Flush() error }); ok {
				_ = flusher.Flush()
			}
			enqueueTrace(events, traceEvent{
				Seq:  seq.Add(1) - 1,
				TsMs: nowMs(),
				Pid:  pid,
				Dir:  dir,
				Raw:  strings.TrimRight(string(outLine), "\r\n"),
			})
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func maybeRewriteClientToServerLine(line []byte, dir string, cfg config) []byte {
	if dir != "client_to_server" || (cfg.ReasoningSummaryOverride == "" && !cfg.EnableExperimentalRawEvents) {
		return line
	}
	return rewriteClientToServerLine(line, cfg)
}

func rewriteClientToServerLine(line []byte, cfg config) []byte {
	content, eol := splitLineEnding(line)
	if len(bytes.TrimSpace(content)) == 0 {
		return line
	}

	var message map[string]any
	if err := json.Unmarshal(content, &message); err != nil {
		return line
	}
	method, _ := message["method"].(string)
	changed := false

	if method == "initialize" && cfg.EnableExperimentalRawEvents {
		params, _ := message["params"].(map[string]any)
		if params == nil {
			params = map[string]any{}
			message["params"] = params
		}
		capabilities, _ := params["capabilities"].(map[string]any)
		if capabilities == nil {
			capabilities = map[string]any{}
			params["capabilities"] = capabilities
		}
		if capabilities["experimentalApi"] != true {
			capabilities["experimentalApi"] = true
			changed = true
		}
	}

	if method == "turn/start" {
		params, _ := message["params"].(map[string]any)
		if params == nil {
			params = map[string]any{}
			message["params"] = params
		}
		if cfg.ReasoningSummaryOverride != "" && params["summary"] != cfg.ReasoningSummaryOverride {
			params["summary"] = cfg.ReasoningSummaryOverride
			changed = true
		}
		if cfg.EnableExperimentalRawEvents && params["experimentalRawEvents"] != true {
			params["experimentalRawEvents"] = true
			changed = true
		}
	}

	if !changed {
		return line
	}

	encoded, err := json.Marshal(message)
	if err != nil {
		return line
	}
	return append(encoded, eol...)
}

func splitLineEnding(line []byte) ([]byte, []byte) {
	if bytes.HasSuffix(line, []byte("\r\n")) {
		return line[:len(line)-2], []byte("\r\n")
	}
	if bytes.HasSuffix(line, []byte("\n")) {
		return line[:len(line)-1], []byte("\n")
	}
	return line, nil
}

func normalizeReasoningSummaryOverride(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func validReasoningSummaryOverride(value string) bool {
	switch normalizeReasoningSummaryOverride(value) {
	case "auto", "concise", "detailed", "none":
		return true
	default:
		return false
	}
}

func enqueueTrace(events chan<- traceEvent, event traceEvent) {
	select {
	case events <- event:
	default:
		// Observability must not backpressure the Desktop/app-server stdio path.
	}
}

func traceSink(wg *sync.WaitGroup, events <-chan traceEvent, cfg config) {
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
		writeHealth(healthPath, 0, 0, 0, fmt.Sprintf("trace sink disabled or unavailable: %v", fallbackErr))
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
			}
		}
		if !wrote && fallback != nil {
			if err := fallback.Write(event); err == nil {
				wrote = true
			}
		}
		if wrote {
			written++
			lastSeq = event.Seq
		} else {
			failed++
		}
		if (written+failed)%50 == 0 {
			flushSink(daemon)
			flushSink(fallback)
			writeHealth(healthPath, written, lastSeq, failed, "")
		}
	}
	flushSink(daemon)
	flushSink(fallback)
	writeHealth(healthPath, written, lastSeq, failed, "")
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
	dropped  uint64
}

func newDaemonSink(url string) *daemonSink {
	network, address, ok := strings.Cut(url, "://")
	if !ok {
		network = "tcp"
		address = url
	}
	if network != "tcp" {
		return &daemonSink{url: url, network: "", address: ""}
	}
	return &daemonSink{url: url, network: network, address: address}
}

func (s *daemonSink) Write(event traceEvent) error {
	if s.network == "" {
		s.dropped++
		return fmt.Errorf("unsupported daemon_url %q", s.url)
	}
	if s.conn == nil {
		if time.Now().Before(s.nextDial) {
			s.dropped++
			return errors.New("daemon disconnected")
		}
		conn, err := net.DialTimeout(s.network, s.address, 300*time.Millisecond)
		if err != nil {
			s.nextDial = time.Now().Add(time.Second)
			s.dropped++
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
		s.dropped++
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

func traceWriter(wg *sync.WaitGroup, events <-chan traceEvent, eventsPath, healthPath string) {
	defer wg.Done()

	file, err := openAppend(eventsPath)
	if err != nil {
		writeHealth(healthPath, 0, 0, 1, fmt.Sprintf("open events failed: %v", err))
		for range events {
		}
		return
	}
	defer file.Close()

	writer := bufio.NewWriter(file)
	defer writer.Flush()

	var written uint64
	var lastSeq uint64
	for event := range events {
		encoded, err := json.Marshal(event)
		if err != nil {
			continue
		}
		if _, err := writer.Write(encoded); err != nil {
			continue
		}
		if err := writer.WriteByte('\n'); err != nil {
			continue
		}
		written++
		lastSeq = event.Seq
		if written%50 == 0 {
			_ = writer.Flush()
			writeHealth(healthPath, written, lastSeq, 0, "")
		}
	}
	writeHealth(healthPath, written, lastSeq, 0, "")
}

func writeHealth(path string, written, lastSeq, dropped uint64, errText string) {
	payload := map[string]any{
		"ts_ms":             nowMs(),
		"written":           written,
		"last_seq":          lastSeq,
		"dropped_by_writer": dropped,
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
