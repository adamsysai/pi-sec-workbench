---
description: "Git workflow — branching, rebasing, cherry-pick, conventional commits, conflict resolution"
---
# Git Workflow

## When to Use

- Setting up branching and merge strategies for a team
- Writing commit messages or PR descriptions
- Resolving merge conflicts or cleaning up history
- Configuring Git hooks (pre-commit, commit-msg, pre-push)

## Procedure

1. **Choose a branching strategy by team size:**
   - **Trunk-based** — short-lived branches, small teams, continuous deployment. Branch from `main`, merge within 1-2 days.
   - **GitHub Flow** — branch from `main`, PR, review, squash-merge. Good for most small-to-mid teams.
   - **GitFlow** — `develop` + `main` + release/hotfix branches. Only for release-managed products with versioned releases.

2. **Write Conventional Commits:**
   ```
   feat(auth): add OAuth2 login flow
   fix(api): handle null user in /v1/users/:id
   docs: update API README
   refactor(db): extract connection pool to module
   chore: bump dependencies
   ```
   - Subject line under 72 characters, imperative mood ("add" not "added")
   - Body explains **why**, not what — the diff shows what

3. **PR workflow:**
   - Branch from latest `main` — `git checkout main && git pull && git checkout -b feat/auth-oauth`
   - Self-review the diff before requesting review
   - Link related issues in the PR description
   - Use squash merge for a clean, one-commit-per-PR history
   - Delete the branch after merge

4. **Rebase vs merge:**
   - **Rebase** your branch on `main` before opening a PR for clean, linear history:
     ```bash
     git fetch origin && git rebase origin/main
     ```
   - **Squash merge** the PR to collapse multiple commits into one
   - **Never rebase shared branches** — only rebase your own feature branch

5. **Resolve conflicts:**
   ```bash
   git fetch origin
   git rebase origin/main
   # Fix conflicts in editor, then:
   git add <resolved-files>
   git rebase --continue
   # Run tests after resolving
   npm test
   ```

6. **Set up Git hooks** with husky or lefthook:
   ```bash
   # pre-commit: lint and format
   npx husky add .husky/pre-commit "npm run lint && npm run format:check"
   # commit-msg: enforce conventional commits
   npx husky add .husky/commit-msg 'npx --no-install commitlint --edit "$1"'
   # pre-push: run tests
   npx husky add .husky/pre-push "npm test"
   ```

7. **Use interactive rebase** to squash or reorder commits before merging:
   ```bash
   git rebase -i HEAD~3  # squash, reword, or drop recent commits
   ```

8. **Use `git bisect`** to find which commit introduced a bug:
   ```bash
   git bisect start
   git bisect bad           # current commit is broken
   git bisect good <sha>    # known working commit
   # Git checks out commits — run tests, mark good/bad until found
   ```

9. **Maintain `.gitignore`:**
   - Ignore build outputs, dependencies (`node_modules/`, `dist/`, `__pycache__/`)
   - Ignore environment files (`.env`, `.env.local`)
   - Ignore editor files (`.vscode/`, `.idea/` — or share settings intentionally)
   - Don't ignore lockfiles (`package-lock.json`, `poetry.lock`, `go.sum`)

## Pitfalls

- Merging instead of rebasing creates "merge commit" noise in history
- Rebasing a branch others have pulled — rewrites history, breaks their local state
- `git push --force` on `main` — always use `--force-with-lease` and never on shared branches
- Commit messages like "fix" or "update" — useless in `git log` and `git bisect`
- Not running hooks in CI — developers can skip hooks with `--no-verify`

## Verification

- `git log --oneline` shows clean, descriptive commit messages
- No merge commits on `main` (if using squash merge)
- `git status` is clean after a PR merge — no leftover branches
- Pre-commit hooks run and pass on every commit
- `git bisect` can identify any regression within ~10 steps on a moderately-sized history
