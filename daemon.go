package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// ensureDaemon makes sure a fresh daemon is running on wsPort.
//
//   - If nothing is listening on the port, spawn one.
//   - If something IS listening, probe /version to verify it's our
//     daemon AND that its binary matches the current executable. A
//     mismatch (after rebuild → old daemon still in memory) means we
//     kill it and respawn so we don't route through stale code.
//   - If the port has a non-turboweb process (collision), surface a
//     clear error rather than spawning blindly.
func ensureDaemon() error {
	if !isDaemonRunning() {
		logger.Printf("Daemon not running, spawning...")
		return spawnDaemon()
	}

	info, probeErr := probeDaemonVersion()
	if probeErr != nil {
		return fmt.Errorf(
			"port %d is in use but not by a turboweb daemon (%v). "+
				"Free the port (e.g. `lsof -i :%d`) and retry",
			wsPort, probeErr, wsPort,
		)
	}

	if daemonIsStale(info) {
		logger.Printf("Daemon at pid %d is stale (binary mtime %s, ours %s) — respawning",
			info.PID, info.BinaryModTime.Format(time.RFC3339), currentBinaryModTime().Format(time.RFC3339))
		if err := terminateDaemon(info.PID); err != nil {
			logger.Printf("Failed to stop stale daemon (pid %d): %v", info.PID, err)
		}
		// Wait for the port to free up; spawn picks up the fresh binary.
		for i := 0; i < 30; i++ {
			if !isDaemonRunning() {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		return spawnDaemon()
	}

	return nil
}

// isDaemonRunning is a cheap TCP-port-open check used as a gate before
// the (more expensive) HTTP /version probe.
func isDaemonRunning() bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", wsPort), 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// probeDaemonVersion does an HTTP GET to /version and validates that
// the response is our daemon's sentinel JSON. Returns the parsed info
// or an error describing why the listener doesn't look like ours.
func probeDaemonVersion() (*daemonVersionInfo, error) {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/version", wsPort))
	if err != nil {
		return nil, fmt.Errorf("GET /version: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var info daemonVersionInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, fmt.Errorf("parse /version: %w", err)
	}
	if info.Service != "turboweb-mcp" {
		return nil, fmt.Errorf("unexpected service identifier %q", info.Service)
	}
	return &info, nil
}

// daemonIsStale reports whether the running daemon's binary is older
// than the current executable on disk — the textbook "I just rebuilt
// but the old daemon is still serving" case.
func daemonIsStale(info *daemonVersionInfo) bool {
	if info.BinaryModTime.IsZero() {
		return false
	}
	mt := currentBinaryModTime()
	if mt.IsZero() {
		return false
	}
	// Allow a small fudge to absorb clock-resolution wobble on macOS.
	return mt.After(info.BinaryModTime.Add(500 * time.Millisecond))
}

func currentBinaryModTime() time.Time {
	exe, err := os.Executable()
	if err != nil {
		return time.Time{}
	}
	st, err := os.Stat(exe)
	if err != nil {
		return time.Time{}
	}
	return st.ModTime().UTC()
}

// terminateDaemon sends SIGTERM to the daemon and waits briefly for the
// port to free. SIGKILL is a last resort — the daemon has no on-disk
// state to corrupt, so a clean shutdown is mostly courtesy.
func terminateDaemon(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	for i := 0; i < 20; i++ {
		time.Sleep(100 * time.Millisecond)
		if !isDaemonRunning() {
			return nil
		}
	}
	// Still alive — force it.
	_ = proc.Signal(syscall.SIGKILL)
	return nil
}

// spawnDaemon launches a detached daemon process running this binary with --ws-server.
func spawnDaemon() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot find own executable: %w", err)
	}

	cmd := exec.Command(exe, "--ws-server")
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	// Detach from parent process group so it survives after we exit.
	setSysProcAttr(cmd)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start daemon: %w", err)
	}

	// Don't wait for it — it's a background daemon.
	go cmd.Wait()

	// Wait for it to be ready. Probe /version (not just TCP) so we
	// don't return until the daemon has actually wired its handlers.
	for i := 0; i < 30; i++ {
		time.Sleep(100 * time.Millisecond)
		if isDaemonRunning() {
			if _, err := probeDaemonVersion(); err == nil {
				logger.Printf("Daemon started (pid %d)", cmd.Process.Pid)
				return nil
			}
		}
	}

	return fmt.Errorf("daemon started but not responding on port %d", wsPort)
}
