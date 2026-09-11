package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/adamsysai/pi-sec-workbench/internal/queue"
)

type Server struct {
	Store    *queue.Store
	Token    string
	WebDir   string
	streams  chan struct{}
	requests chan struct{}
}

func New(store *queue.Store, token, webDir string) (*Server, error) {
	if len(token) < 32 {
		return nil, errors.New("API_TOKEN must contain at least 32 characters")
	}
	return &Server{Store: store, Token: token, WebDir: webDir, streams: make(chan struct{}, 16), requests: make(chan struct{}, 32)}, nil
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.Store.DB.PingContext(ctx); err != nil {
			reply(w, 503, map[string]string{"status": "unavailable"})
			return
		}
		reply(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/snapshot", s.snapshot)
	mux.HandleFunc("GET /api/stream", s.stream)
	mux.HandleFunc("POST /api/tasks", s.create)
	mux.HandleFunc("POST /api/claim", s.claim)
	mux.HandleFunc("GET /api/tasks/{id}", s.get)
	mux.HandleFunc("POST /api/tasks/{id}/heartbeat", s.finish)
	mux.HandleFunc("POST /api/tasks/{id}/complete", s.finish)
	mux.HandleFunc("POST /api/tasks/{id}/fail", s.finish)
	mux.HandleFunc("GET /", s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			header := r.Header.Get("Authorization")
			expected := "Bearer " + s.Token
			if subtle.ConstantTimeCompare([]byte(header), []byte(expected)) != 1 {
				w.Header().Set("WWW-Authenticate", "Bearer")
				reply(w, 401, map[string]string{"error": "authentication required"})
				return
			}
			// Browser API requests must originate from this coordinator; no permissive CORS.
			if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host {
				reply(w, 403, map[string]string{"error": "origin rejected"})
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
			if r.URL.Path != "/api/stream" {
				select {
				case s.requests <- struct{}{}:
					defer func() { <-s.requests }()
				default:
					reply(w, 503, map[string]string{"error": "coordinator busy"})
					return
				}
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				defer cancel()
				r = r.WithContext(ctx)
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		reply(w, 415, map[string]string{"error": "application/json required"})
		return false
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		reply(w, 400, map[string]string{"error": "invalid JSON body"})
		return false
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		reply(w, 400, map[string]string{"error": "one JSON value required"})
		return false
	}
	return true
}
func fail(w http.ResponseWriter, err error) {
	status := 500
	message := "internal error"
	switch {
	case errors.Is(err, queue.ErrInvalid):
		status = 400
		message = err.Error()
	case errors.Is(err, queue.ErrConflict), errors.Is(err, queue.ErrLease):
		status = 409
		message = err.Error()
	case errors.Is(err, queue.ErrNotFound):
		status = 404
		message = err.Error()
	case errors.Is(err, context.DeadlineExceeded):
		status = 503
		message = "request timed out"
	}
	if status == 500 {
		slog.Error("request failed", "error", err)
	}
	reply(w, status, map[string]string{"error": message})
}
func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	var in queue.CreateRequest
	if !decode(w, r, &in) {
		return
	}
	t, err := s.Store.Create(r.Context(), in)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, 201, t)
}
func (s *Server) claim(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Worker string `json:"worker"`
		Kind   string `json:"kind"`
	}
	if !decode(w, r, &in) {
		return
	}
	lease, err := s.Store.Claim(r.Context(), in.Worker, in.Kind)
	if err != nil {
		fail(w, err)
		return
	}
	if lease == nil {
		w.WriteHeader(204)
		return
	}
	reply(w, 200, lease)
}
func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	t, err := s.Store.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, 200, t)
}
func (s *Server) finish(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Worker string          `json:"worker"`
		Token  string          `json:"lease_token"`
		Result json.RawMessage `json:"result"`
	}
	if !decode(w, r, &in) {
		return
	}
	var t queue.Task
	var err error
	switch {
	case strings.HasSuffix(r.URL.Path, "/heartbeat"):
		t, err = s.Store.Heartbeat(r.Context(), r.PathValue("id"), in.Worker, in.Token)
	case strings.HasSuffix(r.URL.Path, "/complete"):
		t, err = s.Store.Complete(r.Context(), r.PathValue("id"), in.Worker, in.Token, in.Result)
	default:
		t, err = s.Store.Fail(r.Context(), r.PathValue("id"), in.Worker, in.Token, in.Result)
	}
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, 200, t)
}

// Public snapshots contain operational metadata, never task input/results or lease tokens.
func publicSnapshot(v queue.Snapshot) queue.Snapshot {
	for i := range v.Tasks {
		v.Tasks[i].Input = json.RawMessage(`{}`)
		v.Tasks[i].Result = json.RawMessage(`{}`)
	}
	return v
}
func (s *Server) snapshot(w http.ResponseWriter, r *http.Request) {
	v, err := s.Store.Snapshot(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, 200, publicSnapshot(v))
}
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	select {
	case s.streams <- struct{}{}:
		defer func() { <-s.streams }()
	default:
		reply(w, 503, map[string]string{"error": "stream limit reached"})
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		reply(w, 500, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		v, err := s.Store.Snapshot(ctx)
		cancel()
		if err != nil {
			return
		}
		body, err := json.Marshal(publicSnapshot(v))
		if err != nil {
			return
		}
		_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err = fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", body); err != nil {
			return
		}
		if err = rc.Flush(); err != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	files := map[string]string{"/": "index.html", "/style.css": "style.css", "/app.js": "dist/app.js"}
	name, ok := files[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(s.WebDir, name)
	if _, err := os.Stat(p); err != nil {
		http.Error(w, "Build the console with npm run build", 503)
		return
	}
	http.ServeFile(w, r, p)
}
