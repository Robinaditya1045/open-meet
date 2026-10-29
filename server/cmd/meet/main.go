// Command meet runs the meeting server: REST API, signaling, SFU and web client
// in one process.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Robinaditya1045/open-meet/server/internal/config"
	"github.com/Robinaditya1045/open-meet/server/internal/meeting"
	"github.com/Robinaditya1045/open-meet/server/internal/server"
	"github.com/Robinaditya1045/open-meet/server/internal/sfu"
)

func main() {
	if err := run(); err != nil {
		slog.Error("meet server failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.LogLevel})))

	engine, err := sfu.NewEngine(sfu.Config{
		UDPPort:           cfg.RTCUDPPort,
		TCPPort:           cfg.RTCTCPPort,
		PublicIPs:         cfg.PublicIPs,
		IPv6:              cfg.IPv6,
		ExcludeInterfaces: cfg.ExcludeInterfaces,
	})
	if err != nil {
		return err
	}
	defer engine.Close()

	store, err := meeting.OpenFileStore(filepath.Join(cfg.DataDir, "meetings.json"))
	if err != nil {
		return err
	}
	registry := meeting.NewRegistry(store, meeting.EngineMedia(engine), meeting.Options{
		MaxParticipants: cfg.MaxParticipants,
		ReconnectGrace:  cfg.ReconnectGrace,
		ICEServers:      cfg.ICEServers,
	})
	registry.Prune(time.Now().Add(-cfg.MeetingTTL))

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: server.New(registry, server.Config{
			AllowedOrigins: cfg.AllowedOrigins,
			WebDir:         cfg.WebDir,
			TrustProxy:     cfg.TrustProxy,
		}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				registry.Prune(time.Now().Add(-cfg.MeetingTTL))
			}
		}
	}()

	errs := make(chan error, 1)
	go func() {
		slog.Info("meet server listening", "addr", cfg.HTTPAddr, "web_dir", cfg.WebDir)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
		close(errs)
	}()

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	// Hijacked WebSockets are not tracked by Shutdown, so meetings are closed
	// explicitly; clients see "server restarting" and reconnect.
	registry.Shutdown()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
