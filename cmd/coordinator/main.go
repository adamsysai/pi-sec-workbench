package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/adamsysai/pi-sec-workbench/internal/httpapi"
	"github.com/adamsysai/pi-sec-workbench/internal/queue"
)

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	duration := 30 * time.Second
	if raw := os.Getenv("LEASE_DURATION"); raw != "" {
		var err error
		duration, err = time.ParseDuration(raw)
		if err != nil {
			return err
		}
	}
	setup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	store, err := queue.Open(setup, dsn, duration)
	if err != nil {
		return err
	}
	defer store.DB.Close()
	if err = store.Migrate(setup); err != nil {
		return err
	}
	web := os.Getenv("WEB_DIR")
	if web == "" {
		web = "web"
	}
	api, err := httpapi.New(store, os.Getenv("API_TOKEN"), web)
	if err != nil {
		return err
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8787"
	}
	server := &http.Server{Addr: addr, Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	errs := make(chan error, 1)
	go func() { slog.Info("coordinator listening", "address", addr); errs <- server.ListenAndServe() }()
	select {
	case err = <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	return server.Shutdown(shutdown)
}
func main() {
	if err := run(); err != nil {
		slog.Error("coordinator stopped", "error", err)
		os.Exit(1)
	}
}
