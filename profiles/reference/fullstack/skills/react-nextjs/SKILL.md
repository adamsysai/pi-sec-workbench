---
description: "React and Next.js development — components, hooks, SSR, App Router, server components"
---
# React + Next.js (App Router)

## When to Use

- Building or modifying pages, layouts, or API routes in a Next.js App Router project
- Deciding Server vs Client component boundaries
- Managing state, data fetching, or metadata in a Next.js app
- Setting up routing, Suspense, or streaming

## Procedure

1. **Default to Server Components.** Only add `'use client'` when you need interactivity, hooks, or browser APIs.

2. **Follow file conventions:**
   - `page.tsx` — route UI
   - `layout.tsx` — shared layout wrapper
   - `loading.tsx` — Suspense fallback for the route
   - `error.tsx` — error boundary (`'use client'` required)
   - `route.ts` — API endpoint (route handler)
   - `not-found.tsx` — 404 UI

3. **Fetch data in Server Components** using `fetch()` with caching options or async ORM calls — no `useEffect` for initial data.

4. **Manage state by complexity:**
   - Local UI state → `useState`
   - Cross-component app state → Context or Zustand
   - Server state → fetch in server component, pass as props

5. **Set metadata** with the Metadata API:
   ```tsx
   export const metadata: Metadata = {
     title: { default: 'App', template: '%s | App' },
     openGraph: { images: ['/og.png'] },
   };
   ```

6. **Use Suspense for streaming:**
   ```tsx
   <Suspense fallback={<Skeleton />}>
     <SlowComponent />
   </Suspense>
   ```

7. **Choose rendering strategy:**
   - Static → default, no fetch or `cache: 'force-cache'`
   - Dynamic → `cache: 'no-store'` or uses dynamic functions (`cookies()`, `headers()`)

8. **Use route handlers** for API endpoints in `route.ts`:
   ```ts
   export async function GET(req: Request) {
     return Response.json({ ok: true });
   }
   ```

9. **Co-locate custom hooks** in the same directory or a `hooks/` folder. Always prefix with `use`.

10. **Use `key` prop** to force remount when identity changes:
    ```tsx
    <Profile key={userId} userId={userId} />
    ```

## Pitfalls

- `'use client'` at the top of a layout makes all children client-side — keep the boundary as low as possible
- Passing non-serializable props (functions, class instances) from Server to Client components fails
- `useEffect` for data fetching causes waterfalls — use server-side fetch or a data library
- Forgetting `export default` on `page.tsx` breaks routing

## Verification

- `next build` completes with no errors
- Server Components show no client JS bundle for their content (check build output)
- `loading.tsx` shows during slow data fetches
- Metadata renders in `<head>` on page source
- All pages have corresponding `error.tsx` and `loading.tsx`
