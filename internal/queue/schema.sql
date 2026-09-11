CREATE TABLE IF NOT EXISTS tasks (
 id text PRIMARY KEY,
 request_key text NOT NULL UNIQUE,
 fingerprint text NOT NULL,
 title text NOT NULL,
 kind text NOT NULL DEFAULT 'demo',
 input jsonb NOT NULL DEFAULT '{}',
 dependencies jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
 worker text NOT NULL DEFAULT '',
 lease_token text NOT NULL DEFAULT '',
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
 result jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks (created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tasks_expiry_idx ON tasks (lease_until) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS task_events (
 id bigserial PRIMARY KEY,
 task_id text NOT NULL REFERENCES tasks(id),
 action text NOT NULL,
 worker text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS task_events_recent_idx ON task_events (id DESC);
