package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func testStore(t testing.TB) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("REQUIRE_DB_TESTS") == "1" {
			t.Fatal("TEST_DATABASE_URL required")
		}
		t.Skip("integration test: set TEST_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := Open(ctx, dsn, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	name := "test_" + randomID()
	if _, err = admin.DB.Exec(`CREATE SCHEMA ` + name); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", name)
	u.RawQuery = q.Encode()
	s, err := Open(ctx, u.String(), 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.DB.Close(); _, _ = admin.DB.Exec(`DROP SCHEMA ` + name + ` CASCADE`); admin.DB.Close() })
	return s
}
func create(t testing.TB, s *Store, key string, deps ...string) Task {
	t.Helper()
	v, err := s.Create(context.Background(), CreateRequest{RequestKey: key, Title: key, Dependencies: deps})
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func claim(t testing.TB, s *Store, worker string) *Lease {
	t.Helper()
	v, err := s.Claim(context.Background(), worker, "")
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func expire(t testing.TB, s *Store, id string) {
	t.Helper()
	if _, err := s.DB.Exec(`UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
}
func TestConcurrentClaim(t *testing.T) {
	s := testStore(t)
	create(t, s, "one")
	var wg sync.WaitGroup
	results := make(chan *Lease, 32)
	errs := make(chan error, 32)
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := s.Claim(context.Background(), fmt.Sprint(i), "")
			results <- v
			errs <- e
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	count := 0
	for v := range results {
		if v != nil {
			count++
		}
	}
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if count != 1 {
		t.Fatalf("got %d owners, want 1", count)
	}
}
func TestConcurrentCreateIdempotency(t *testing.T) {
	s := testStore(t)
	var wg sync.WaitGroup
	ids := make(chan string, 16)
	errs := make(chan error, 16)
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := s.Create(context.Background(), CreateRequest{RequestKey: "same", Title: "same"})
			ids <- v.ID
			errs <- e
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	unique := map[string]bool{}
	for id := range ids {
		unique[id] = true
	}
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	if len(unique) != 1 {
		t.Fatal(unique)
	}
	_, e := s.Create(context.Background(), CreateRequest{RequestKey: "same", Title: "changed"})
	if !errors.Is(e, ErrConflict) {
		t.Fatalf("want conflict, got %v", e)
	}
}
func TestRecoveryFencesOldWorker(t *testing.T) {
	s := testStore(t)
	task := create(t, s, "crash")
	a := claim(t, s, "a")
	expire(t, s, task.ID)
	if _, e := s.Complete(context.Background(), task.ID, "a", a.Token, json.RawMessage(`{}`)); !errors.Is(e, ErrLease) {
		t.Fatalf("expired completion accepted: %v", e)
	}
	b := claim(t, s, "b")
	if b == nil || b.Token == a.Token || b.Task.Attempts != 2 {
		t.Fatal("task not recovered with new lease")
	}
	if _, e := s.Heartbeat(context.Background(), task.ID, "a", a.Token); !errors.Is(e, ErrLease) {
		t.Fatalf("stale heartbeat accepted: %v", e)
	}
	if _, e := s.Complete(context.Background(), task.ID, "a", a.Token, json.RawMessage(`{}`)); !errors.Is(e, ErrLease) {
		t.Fatalf("stale completion accepted: %v", e)
	}
	if _, e := s.Complete(context.Background(), task.ID, "b", b.Token, json.RawMessage(`{"ok":true}`)); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Complete(context.Background(), task.ID, "b", b.Token, json.RawMessage(`{}`)); !errors.Is(e, ErrLease) {
		t.Fatalf("duplicate completion accepted: %v", e)
	}
}
func TestDependenciesAndRetryLimit(t *testing.T) {
	s := testStore(t)
	a := create(t, s, "parent")
	child := create(t, s, "child", a.ID)
	for range 3 {
		v := claim(t, s, "worker")
		if v == nil || v.Task.ID != a.ID {
			t.Fatal("child ran before parent")
		}
		expire(t, s, a.ID)
	}
	if v := claim(t, s, "worker"); v != nil {
		t.Fatal("exhausted task was reclaimed")
	}
	for _, id := range []string{a.ID, child.ID} {
		v, e := s.Get(context.Background(), id)
		if e != nil || v.Status != "failed" {
			t.Fatalf("not failed: %+v %v", v, e)
		}
	}
}
func TestSuccessfulDependencyAndDurability(t *testing.T) {
	s := testStore(t)
	a := create(t, s, "parent")
	b := create(t, s, "child", a.ID)
	lease := claim(t, s, "first")
	if _, e := s.Complete(context.Background(), a.ID, "first", lease.Token, json.RawMessage(`{"proof":"synthetic"}`)); e != nil {
		t.Fatal(e)
	}
	// A separate pool models a restarted coordinator using the same durable database.
	dsn := os.Getenv("TEST_DATABASE_URL")
	u, _ := url.Parse(dsn)
	var schemaName string
	if e := s.DB.QueryRow(`SELECT current_schema()`).Scan(&schemaName); e != nil {
		t.Fatal(e)
	}
	q := u.Query()
	q.Set("search_path", schemaName)
	u.RawQuery = q.Encode()
	restarted, e := Open(context.Background(), u.String(), 30*time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer restarted.DB.Close()
	next := claim(t, restarted, "second")
	if next == nil || next.Task.ID != b.ID {
		t.Fatal("dependency or persistence failed")
	}
	snap, e := restarted.Snapshot(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if snap.Counts["completed"] != 1 || snap.Counts["running"] != 1 {
		t.Fatal(snap.Counts)
	}
}
func TestHeartbeatOwnershipAndInput(t *testing.T) {
	s := testStore(t)
	a := create(t, s, "work")
	l := claim(t, s, "owner")
	if _, e := s.Heartbeat(context.Background(), a.ID, "other", l.Token); !errors.Is(e, ErrLease) {
		t.Fatal("other worker accepted")
	}
	if _, e := s.Heartbeat(context.Background(), a.ID, "owner", l.Token); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Complete(context.Background(), a.ID, "owner", l.Token, json.RawMessage(`[]`)); !errors.Is(e, ErrInvalid) {
		t.Fatal("invalid result accepted")
	}
	if _, e := s.Create(context.Background(), CreateRequest{RequestKey: "bad", Title: "bad", Dependencies: []string{randomID()}}); !errors.Is(e, ErrInvalid) {
		t.Fatal("missing dependency accepted")
	}
}
func TestNormalize(t *testing.T) {
	for _, r := range []CreateRequest{{}, {RequestKey: "x", Title: "x", Input: json.RawMessage(`null`)}, {RequestKey: "x", Title: "x", MaxAttempts: 6}} {
		if r.normalize() == nil {
			t.Fatal("accepted invalid request")
		}
	}
}
func BenchmarkCreateClaimComplete(b *testing.B) {
	s := testStore(b)
	ctx := context.Background()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			id := randomID()
			_, e := s.Create(ctx, CreateRequest{RequestKey: id, Title: "benchmark"})
			if e != nil {
				b.Error(e)
				return
			}
			claimCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			var l *Lease
			// SKIP LOCKED can temporarily return no row while peers hold locks.
			for l == nil && e == nil {
				l, e = s.Claim(claimCtx, id, "")
				if l == nil && e == nil {
					time.Sleep(time.Millisecond)
				}
			}
			cancel()
			if e != nil {
				b.Errorf("claim: %v", e)
				return
			}
			if _, e = s.Complete(ctx, l.Task.ID, id, l.Token, json.RawMessage(`{}`)); e != nil {
				b.Error(e)
				return
			}
		}
	})
}

func TestIdempotencyPreservesLargeIntegerInput(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	first, err := s.Create(ctx, CreateRequest{RequestKey: "large-number", Title: "Large number", Input: json.RawMessage(`{"number":9007199254740993}`)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(first.Input), "9007199254740993") {
		t.Fatalf("precision lost: %s", first.Input)
	}
	_, err = s.Create(ctx, CreateRequest{RequestKey: "large-number", Title: "Large number", Input: json.RawMessage(`{"number":9007199254740992}`)})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
}
