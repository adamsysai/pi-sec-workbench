// Package queue implements durable, leased tasks for a single trusted workspace.
package queue

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed schema.sql
var schema string

var (
	ErrInvalid  = errors.New("invalid request")
	ErrConflict = errors.New("idempotency key reused with different input")
	ErrLease    = errors.New("lease expired or not owned by this worker")
	ErrNotFound = errors.New("task not found")
)

type Task struct {
	ID           string          `json:"id"`
	Title        string          `json:"title"`
	Kind         string          `json:"kind"`
	Input        json.RawMessage `json:"input"`
	Dependencies json.RawMessage `json:"dependencies"`
	Status       string          `json:"status"`
	Worker       string          `json:"worker"`
	LeaseUntil   *time.Time      `json:"lease_until"`
	Attempts     int             `json:"attempts"`
	MaxAttempts  int             `json:"max_attempts"`
	Result       json.RawMessage `json:"result"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

type CreateRequest struct {
	RequestKey   string          `json:"request_key"`
	Title        string          `json:"title"`
	Kind         string          `json:"kind"`
	Input        json.RawMessage `json:"input"`
	Dependencies []string        `json:"dependencies"`
	MaxAttempts  int             `json:"max_attempts"`
}

type Lease struct {
	Task  Task   `json:"task"`
	Token string `json:"lease_token"`
}

type Event struct {
	ID        int64     `json:"id"`
	TaskID    string    `json:"task_id"`
	Action    string    `json:"action"`
	Worker    string    `json:"worker"`
	CreatedAt time.Time `json:"created_at"`
}

type Snapshot struct {
	Tasks  []Task         `json:"tasks"`
	Events []Event        `json:"events"`
	Counts map[string]int `json:"counts"`
}

type Store struct {
	DB            *sql.DB
	LeaseDuration time.Duration
}

func Open(ctx context.Context, dsn string, lease time.Duration) (*Store, error) {
	if lease < time.Second || lease > 10*time.Minute {
		return nil, fmt.Errorf("lease duration must be 1s..10m")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err = db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{DB: db, LeaseDuration: lease}, nil
}

// Migrate serializes initial schema creation across coordinator replicas.
func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(72419001)"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	return tx.Commit()
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func validObject(raw json.RawMessage) bool {
	var v map[string]json.RawMessage
	return len(raw) <= 8192 && json.Unmarshal(raw, &v) == nil && v != nil
}

func (r *CreateRequest) normalize() error {
	r.Title = strings.TrimSpace(r.Title)
	if r.Kind == "" {
		r.Kind = "demo"
	}
	if r.MaxAttempts == 0 {
		r.MaxAttempts = 3
	}
	if len(r.Input) == 0 {
		r.Input = json.RawMessage(`{}`)
	}
	if r.Dependencies == nil {
		r.Dependencies = []string{}
	}
	if len(r.RequestKey) < 1 || len(r.RequestKey) > 128 || len(r.Title) < 1 || len(r.Title) > 200 || len(r.Kind) > 64 || r.MaxAttempts < 1 || r.MaxAttempts > 5 || len(r.Dependencies) > 32 || !validObject(r.Input) {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, id := range r.Dependencies {
		if len(id) != 32 || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
	}
	// Canonical JSON makes whitespace/key order irrelevant for idempotent retries.
	var obj any
	dec := json.NewDecoder(bytes.NewReader(r.Input))
	dec.UseNumber()
	_ = dec.Decode(&obj)
	r.Input, _ = json.Marshal(obj)
	return nil
}

const columns = `id,title,kind,input,dependencies,status,worker,lease_until,attempts,max_attempts,result,created_at,updated_at`

type scanner interface{ Scan(...any) error }

func scanTask(row scanner) (Task, error) {
	var t Task
	err := row.Scan(&t.ID, &t.Title, &t.Kind, &t.Input, &t.Dependencies, &t.Status, &t.Worker, &t.LeaseUntil, &t.Attempts, &t.MaxAttempts, &t.Result, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

func (s *Store) Create(ctx context.Context, r CreateRequest) (Task, error) {
	if err := r.normalize(); err != nil {
		return Task{}, err
	}
	raw, _ := json.Marshal(r)
	sum := sha256.Sum256(raw)
	fp := hex.EncodeToString(sum[:])
	deps, _ := json.Marshal(r.Dependencies)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	for _, id := range r.Dependencies {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE id=$1)`, id).Scan(&exists); err != nil {
			return Task{}, err
		}
		if !exists {
			return Task{}, fmt.Errorf("%w: dependency does not exist", ErrInvalid)
		}
	}
	// Unique request_key blocks conflicting concurrent inserts until their transaction commits.
	task, err := scanTask(tx.QueryRowContext(ctx, `INSERT INTO tasks (id,request_key,fingerprint,title,kind,input,dependencies,max_attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (request_key) DO NOTHING RETURNING `+columns, randomID(), r.RequestKey, fp, r.Title, r.Kind, string(r.Input), string(deps), r.MaxAttempts))
	if errors.Is(err, sql.ErrNoRows) {
		var old string
		if err = tx.QueryRowContext(ctx, `SELECT fingerprint FROM tasks WHERE request_key=$1`, r.RequestKey).Scan(&old); err != nil {
			return Task{}, err
		}
		if old != fp {
			return Task{}, ErrConflict
		}
		task, err = scanTask(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM tasks WHERE request_key=$1`, r.RequestKey))
	} else if err == nil {
		err = event(ctx, tx, task.ID, "created", "")
	}
	if err != nil {
		return Task{}, err
	}
	if err = tx.Commit(); err != nil {
		return Task{}, err
	}
	return task, nil
}

func event(ctx context.Context, tx *sql.Tx, id, action, worker string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO task_events(task_id,action,worker) VALUES($1,$2,$3)`, id, action, worker)
	return err
}

// recoverExpired is bounded; claim attempts drive recovery, without a second scheduler.
func recoverExpired(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `WITH expired AS (
 SELECT id FROM tasks WHERE status='running' AND lease_until<=clock_timestamp() ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED
 ), changed AS (
 UPDATE tasks SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
 worker='',lease_token='',lease_until=NULL,updated_at=clock_timestamp()
 WHERE id IN(SELECT id FROM expired) RETURNING id,status)
 INSERT INTO task_events(task_id,action) SELECT id,CASE WHEN status='failed' THEN 'attempts_exhausted' ELSE 'lease_expired' END FROM changed`)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `WITH blocked AS (
 SELECT t.id FROM tasks t WHERE t.status='pending' AND EXISTS (
 SELECT 1 FROM jsonb_array_elements_text(t.dependencies) d JOIN tasks parent ON parent.id=d.value WHERE parent.status='failed'
 ) LIMIT 100 FOR UPDATE OF t SKIP LOCKED
 ), changed AS (UPDATE tasks SET status='failed',updated_at=clock_timestamp() WHERE id IN(SELECT id FROM blocked) RETURNING id)
 INSERT INTO task_events(task_id,action) SELECT id,'dependency_failed' FROM changed`)
	return err
}

func (s *Store) Claim(ctx context.Context, worker, kind string) (*Lease, error) {
	if len(worker) == 0 || len(worker) > 100 || len(kind) > 64 {
		return nil, ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = recoverExpired(ctx, tx); err != nil {
		return nil, err
	}
	token := randomID()
	row := tx.QueryRowContext(ctx, `UPDATE tasks SET status='running',worker=$1,lease_token=$2,
 lease_until=clock_timestamp()+($3 * interval '1 second'),attempts=attempts+1,updated_at=clock_timestamp()
 WHERE id=(SELECT t.id FROM tasks t WHERE t.status='pending' AND ($4='' OR t.kind=$4)
 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.dependencies) d JOIN tasks parent ON parent.id=d.value WHERE parent.status<>'completed')
 ORDER BY t.created_at,t.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED) RETURNING `+columns, worker, token, s.LeaseDuration.Seconds(), kind)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = event(ctx, tx, t.ID, "claimed", worker); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return &Lease{Task: t, Token: token}, nil
}

// updateLease locks the row before testing the database clock. A waiting stale
// worker cannot finish using a condition evaluated before another transaction.
func (s *Store) updateLease(ctx context.Context, id, worker, token, action string, result json.RawMessage) (Task, error) {
	if worker == "" || token == "" || len(worker) > 100 || len(token) != 32 {
		return Task{}, ErrLease
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	var locked string
	if err = tx.QueryRowContext(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, id).Scan(&locked); errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrNotFound
	} else if err != nil {
		return Task{}, err
	}
	var query string
	if action == "heartbeat" {
		query = `UPDATE tasks SET lease_until=clock_timestamp()+($4 * interval '1 second'),updated_at=clock_timestamp() WHERE id=$1 AND worker=$2 AND lease_token=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING ` + columns
		t, e := scanTask(tx.QueryRowContext(ctx, query, id, worker, token, s.LeaseDuration.Seconds()))
		if errors.Is(e, sql.ErrNoRows) {
			return Task{}, ErrLease
		}
		if e != nil {
			return Task{}, e
		}
		return t, tx.Commit()
	}
	if !validObject(result) {
		return Task{}, ErrInvalid
	}
	status := "completed"
	if action == "failed" {
		status = "failed"
	}
	query = `UPDATE tasks SET status=$4,result=$5,lease_until=NULL,lease_token='',updated_at=clock_timestamp() WHERE id=$1 AND worker=$2 AND lease_token=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING ` + columns
	t, err := scanTask(tx.QueryRowContext(ctx, query, id, worker, token, status, string(result)))
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, ErrLease
	}
	if err != nil {
		return Task{}, err
	}
	if err = event(ctx, tx, id, status, worker); err != nil {
		return Task{}, err
	}
	return t, tx.Commit()
}
func (s *Store) Heartbeat(ctx context.Context, id, worker, token string) (Task, error) {
	return s.updateLease(ctx, id, worker, token, "heartbeat", nil)
}
func (s *Store) Complete(ctx context.Context, id, worker, token string, result json.RawMessage) (Task, error) {
	return s.updateLease(ctx, id, worker, token, "completed", result)
}
func (s *Store) Fail(ctx context.Context, id, worker, token string, result json.RawMessage) (Task, error) {
	return s.updateLease(ctx, id, worker, token, "failed", result)
}
func (s *Store) Get(ctx context.Context, id string) (Task, error) {
	t, err := scanTask(s.DB.QueryRowContext(ctx, `SELECT `+columns+` FROM tasks WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return t, err
}

// Snapshot returns a bounded, consistent view. It never includes lease tokens.
// Clients replace their view; this is not an exactly-once event delivery API.
func (s *Store) Snapshot(ctx context.Context) (Snapshot, error) {
	v := Snapshot{Tasks: []Task{}, Events: []Event{}, Counts: map[string]int{"pending": 0, "running": 0, "completed": 0, "failed": 0}}
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM tasks ORDER BY created_at DESC,id DESC LIMIT 100`)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		t, e := scanTask(rows)
		if e != nil {
			rows.Close()
			return v, e
		}
		v.Tasks = append(v.Tasks, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT status,count(*) FROM tasks GROUP BY status`)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var k string
		var count int
		if err = rows.Scan(&k, &count); err != nil {
			rows.Close()
			return v, err
		}
		v.Counts[k] = count
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,task_id,action,worker,created_at FROM task_events ORDER BY id DESC LIMIT 100`)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var e Event
		if err = rows.Scan(&e.ID, &e.TaskID, &e.Action, &e.Worker, &e.CreatedAt); err != nil {
			rows.Close()
			return v, err
		}
		v.Events = append(v.Events, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	return v, tx.Commit()
}
