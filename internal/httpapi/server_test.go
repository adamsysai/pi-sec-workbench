package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/adamsysai/pi-sec-workbench/internal/queue"
)

func TestAPIRejectsUnauthenticatedRequests(t *testing.T) {
	s, _ := New(nil, strings.Repeat("test-only", 5), t.TempDir())
	for _, path := range []string{"/api/snapshot", "/api/stream", "/api/tasks", "/api/claim", "/api/tasks/abc", "/api/tasks/abc/heartbeat", "/api/tasks/abc/complete", "/api/tasks/abc/fail"} {
		for _, method := range []string{"GET", "POST"} {
			req := httptest.NewRequest(method, path, nil)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, req)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: %d", method, path, w.Code)
			}
		}
	}
}
func TestRejectsMalformedRequestsAndForeignOrigin(t *testing.T) {
	token := strings.Repeat("test-only", 5)
	s, _ := New(nil, token, t.TempDir())
	for _, tc := range []struct {
		body, origin, content string
		status                int
	}{
		{`{}`, "https://attacker.invalid", "application/json", 403},
		{`{"unknown":true}`, "", "application/json", 400},
		{`{} {}`, "", "application/json", 400},
		{`{}`, "", "text/plain", 415},
		{`{"title":"` + strings.Repeat("x", 70<<10) + `"}`, "", "application/json", 400},
	} {
		req := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", tc.content)
		req.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Fatalf("wanted %d got %d", tc.status, w.Code)
		}
	}
}
func TestSnapshotRedactsPayloadsAndStaticNeverServesSecrets(t *testing.T) {
	snapshot := publicSnapshot(queue.Snapshot{Tasks: []queue.Task{{Input: json.RawMessage(`{"private":"sensitive"}`), Result: json.RawMessage(`{"private":"sensitive"}`)}}})
	raw, _ := json.Marshal(snapshot)
	if strings.Contains(string(raw), "sensitive") || strings.Contains(string(raw), "lease_token") {
		t.Fatal("snapshot leaked private fields")
	}
	s, _ := New(nil, strings.Repeat("test-only", 5), t.TempDir())
	for _, path := range []string{"/.env", "/.git/config", "/profiles/reference/sec/profile.json"} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Fatalf("%s: %d", path, w.Code)
		}
		if w.Header().Get("Content-Security-Policy") == "" {
			t.Fatal("missing CSP")
		}
	}
}
func TestBackpressure(t *testing.T) {
	token := strings.Repeat("test-only", 5)
	s, _ := New(nil, token, t.TempDir())
	for i := 0; i < cap(s.requests); i++ {
		s.requests <- struct{}{}
	}
	for i := 0; i < cap(s.streams); i++ {
		s.streams <- struct{}{}
	}
	for _, path := range []string{"/api/snapshot", "/api/stream"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, req)
		if w.Code != 503 {
			t.Fatalf("expected overload rejection: %s = %d", path, w.Code)
		}
	}
}
