package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"time"
)

// ensureDaemon checks if the WS daemon is running and spawns it if not.
func ensureDaemon() error {
	if isDaemonRunning() {
		return nil
	}

	logger.Printf("Daemon not running, spawning...")
	return spawnDaemon()
}

// isDaemonRunning checks if something is listening on the WS port.
func isDaemonRunning() bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", wsPort), 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
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

	// Wait for it to be ready.
	for i := 0; i < 30; i++ {
		time.Sleep(100 * time.Millisecond)
		if isDaemonRunning() {
			logger.Printf("Daemon started (pid %d)", cmd.Process.Pid)
			return nil
		}
	}

	return fmt.Errorf("daemon started but not responding on port %d", wsPort)
}
