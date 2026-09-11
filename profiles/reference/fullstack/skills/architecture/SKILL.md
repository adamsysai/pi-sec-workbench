---
description: "Software architecture — patterns, microservices, event-driven, DDD, CQRS"
---
# Software Architecture

## When to Use

- Starting a new project and deciding on architectural style
- Designing service boundaries, module structure, or data flow
- Evaluating monolith vs microservices, or introducing event-driven patterns
- Reviewing codebase structure for maintainability and scalability

## Procedure

1. **Apply the dependency rule (Clean Architecture):** outer layers depend on inner layers, never the reverse. The domain layer has zero external dependencies:
   ```
   Domain (entities, use cases) → Application (services) → Infrastructure (DB, APIs) → Presentation (controllers, UI)
   ```

2. **Use hexagonal (ports-and-adapters) for testability:** define ports as interfaces in the domain, implement adapters in infrastructure:
   ```ts
   // Domain defines the port
   interface UserRepository {
     findById(id: string): Promise<User | null>;
   }
   // Infrastructure implements the adapter
   class PostgresUserRepository implements UserRepository { ... }
   ```

3. **Apply DDD building blocks** for complex domains:
   - **Entities** — objects with identity (e.g., `User`)
   - **Value Objects** — immutable, compared by value (e.g., `EmailAddress`)
   - **Aggregates** — consistency boundaries with a root entity (e.g., `Order` with `OrderItem`s)
   - **Domain Events** — `OrderPlaced`, emitted by the aggregate
   - **Repositories** — persistence abstraction, one per aggregate root

4. **Define bounded contexts** as the boundary for a domain model — don't share `User` across contexts, use context-specific representations.

5. **Evaluate microservices trade-offs:**
   - Pros: independent deployment, scaling, team autonomy
   - Cons: operational complexity, network latency, distributed transactions, harder debugging
   - Start monolith → extract services when a boundary is proven and stable

6. **Use event-driven architecture** for decoupled communication:
   - Message broker: Kafka, NATS, RabbitMQ
   - Events are immutable, published after state change
   - Consumers are idempotent (at-least-once delivery is the norm)
   - Use the **outbox pattern** to atomically persist state + publish event

7. **Apply CQRS** when read and write workloads differ significantly:
   - Separate write model (commands, optimized for validation) from read model (queries, optimized for reads)
   - Read model updated asynchronously via domain events (eventual consistency)

8. **Use the saga pattern** for distributed transactions — orchestration or choreography with compensating actions.

9. **Add an anti-corruption layer** when integrating legacy systems — translate external models into your bounded context's language.

## Pitfalls

- Over-engineering — applying DDD/CQRS to a CRUD app adds unnecessary complexity
- Shared database between microservices — creates hidden coupling
- Eventual consistency without clear user communication — users see stale data without knowing
- Domain logic leaking into controllers or infrastructure — violating the dependency rule

## Verification

- Domain layer has zero imports from infrastructure or framework packages
- Each aggregate enforces its own invariants (can't create an invalid state)
- Bounded contexts don't share entity types — they communicate via events or mapped DTOs
- Removing an infrastructure adapter (e.g., swapping Postgres for Mongo) only requires new adapter implementation, no domain changes
- Architecture decision records (ADRs) document major decisions and trade-offs
