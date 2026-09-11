---
description: "TypeScript development — types, generics, decorators, tsconfig, build patterns"
---
# TypeScript Best Practices

## When to Use

- Writing new TypeScript files or modifying existing `.ts`/`.tsx`
- Configuring `tsconfig.json` for a project or monorepo
- Reviewing TypeScript code for type safety and correctness
- Setting up shared types across packages in a monorepo

## Procedure

1. **Enable strict mode** in `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "strict": true,
       "noUncheckedIndexedAccess": true,
       "noImplicitOverride": true,
       "forceConsistentCasingInFileNames": true
     }
   }
   ```

2. **Replace `any` with `unknown`** then narrow using type guards:
   ```ts
   function parse(value: unknown): string {
     if (typeof value === 'string') return value;
     throw new Error('Expected string');
   }
   ```

3. **Use discriminated unions** for state machines and tagged variants:
   ```ts
   type Result<T> =
     | { status: 'ok'; data: T }
     | { status: 'error'; message: string };
   ```

4. **Constrain generics** with `extends` to avoid losing type info:
   ```ts
   function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> { ... }
   ```

5. **Leverage utility types** instead of redefining: `Partial<T>`, `Omit<T, K>`, `Pick<T, K>`, `Record<K, V>`, `ReturnType<F>`, `Parameters<F>`.

6. **Use `import type`** for type-only imports to reduce runtime bundle size:
   ```ts
   import type { User } from './types';
   ```

7. **Use `satisfies`** to validate a value conforms to a type while preserving narrower inferred types:
   ```ts
   const config = { port: 3000 } satisfies Config;
   ```

8. **Set up path aliases and project references** in monorepos:
   ```json
   {
     "compilerOptions": { "paths": { "@app/*": ["./src/*"] } },
     "references": [{ "path": "./packages/shared" }]
   }
   ```

9. **Use `const` assertions** for literal inference: `const roles = ['admin', 'user'] as const;`

10. **Use branded types** for domain identity: `type UserId = string & { readonly _brand: unique symbol };`

## Pitfalls

- `as` casts silence the compiler — prefer type guards and narrowing
- `any` propagates through the call chain — use `unknown` as the escape hatch
- Forgetting `type` in `import type` pulls unused runtime code
- `strict: true` without `noUncheckedIndexedAccess` leaves array access unsafe

## Verification

- `tsc --noEmit` passes with zero errors
- No `any` types in the codebase (`grep -rn ': any' src/`)
- IDE shows type errors inline, not just at build time
- Shared types resolve correctly across monorepo packages
