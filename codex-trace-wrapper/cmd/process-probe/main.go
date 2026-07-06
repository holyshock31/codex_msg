package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	paths := []string{
		filepath.Join(os.Getenv("USERPROFILE"), ".codex-trace", "process-probe.txt"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "CodexTrace", "process-probe.txt"),
		filepath.Join(os.TempDir(), "CodexTrace", "process-probe.txt"),
	}
	line := fmt.Sprintf("%s pid=%d ppid=%d exe=%s args=%s\n", time.Now().Format(time.RFC3339Nano), os.Getpid(), os.Getppid(), executablePath(), strings.Join(os.Args, "\x1f"))
	for _, path := range paths {
		if path == "" {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			continue
		}
		if err := os.WriteFile(path, []byte(line), 0o600); err == nil {
			return
		}
	}
}

func executablePath() string {
	exe, err := os.Executable()
	if err != nil {
		return "error:" + err.Error()
	}
	return exe
}
