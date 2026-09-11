---
description: "Go development — goroutines, channels, interfaces, modules, testing"
---
# Go Backend

## When to Use

- Building or modifying a Go backend service
- Structuring a new Go project layout
- Working with interfaces, goroutines, context, or error handling
- Setting up modules, testing, or profiling

## Procedure

1. **Follow the standard project layout:**
   ```
   cmd/
     server/main.go        # entry point
   internal/                # unexported packages
     handler/
     service/
     repository/
   pkg/                     # exported, reusable packages
   go.mod
   ```

2. **Define interfaces at the consumer side**, keeping them small:
   ```go
   // in service package — only methods it needs
   type UserStore interface {
       GetByID(ctx context.Context, id string) (*User, error)
   }
   ```

3. **Handle errors explicitly** — wrap with context, use sentinel errors:
   ```go
   var ErrNotFound = errors.New("user not found")

   if err := repo.Get(ctx, id); err != nil {
       if errors.Is(err, ErrNotFound) { ... }
       return fmt.Errorf("get user %s: %w", id, err)
   }
   ```

4. **Use `errgroup` for concurrent goroutines with error propagation:**
   ```go
   g, ctx := errgroup.WithContext(ctx)
   g.Go(func() error { return fetchUsers(ctx) })
   g.Go(func() error { return fetchOrders(ctx) })
   if err := g.Wait(); err != nil { ... }
   ```

5. **Always pass `context.Context`** as the first parameter for cancellation and timeouts:
   ```go
   func (s *Service) GetUser(ctx context.Context, id string) (*User, error)
   ```

6. **Use channels for coordination** — prefer `select` with a done channel:
   ```go
   select {
   case result := <-ch:
       return result, nil
   case <-ctx.Done():
       return nil, ctx.Err()
   }
   ```

7. **Initialize and manage modules:**
   ```bash
   go mod init github.com/org/repo
   go mod tidy
   ```

8. **Write table-driven tests:**
   ```go
   func TestParse(t *testing.T) {
       cases := []struct{ name string; input string; want int }{
           {"positive", "42", 42},
           {"negative", "-1", -1},
       }
       for _, tc := range cases {
           t.Run(tc.name, func(t *testing.T) {
               got, _ := parse(tc.input)
               assert.Equal(t, tc.want, got)
           })
       }
   }
   ```

9. **Use `slog`** for structured logging (Go 1.21+).

10. **Profile with `pprof`** when investigating CPU or memory issues.

## Pitfalls

- Goroutine leaks — always use `ctx.Done()` or a done channel to allow goroutines to exit
- Not wrapping errors loses the call stack context — always use `%w`
- Defining large interfaces at the producer side makes them hard to mock
- `go mod tidy` not run after adding imports — CI build breaks

## Verification

- `go build ./...` and `go vet ./...` pass cleanly
- `go test ./... -race` passes with no data races
- `gofmt -l .` outputs nothing (all files formatted)
- All public functions have doc comments
- No goroutine leaks in tests (`go test -race` catches most)
