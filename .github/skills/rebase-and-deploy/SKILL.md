---
name: rebase-and-deploy
description: "Rebase a feature branch onto main, resolve merge conflicts, validate the result compiles and runs, then deploy. Use when: rebasing, merging main into a feature branch, resolving merge conflicts, deploying after a merge, or ensuring code still works after integration. Covers git fetch, pull, rebase, conflict resolution, syntax validation, and smoke testing before deploy."
---

# Rebase and Deploy

Rebase a feature branch onto the latest `main`, resolve any conflicts carefully, validate the result actually works, and deploy.

## When to Use

- "Pull main and rebase my branch"
- "Merge main into feature branch"
- "Resolve merge conflicts and deploy"
- "Rebase and deploy"
- Any workflow that integrates changes from `main` into a feature branch

## Procedure

### 1. Check Working Tree is Clean

```bash
git status
git branch --show-current
```

If there are uncommitted changes, either commit them or stash before proceeding.

### 2. Fetch and Pull Main

```bash
git fetch origin
git checkout main
git pull origin main
```

### 3. Rebase Feature Branch

```bash
git checkout <feature-branch>
git rebase main
```

### 4. Resolve Conflicts (if any)

For each conflicted file:

```bash
# Find conflict markers
grep -n "<<<<<<\|======\|>>>>>>" <file>
```

**Read both sides of the conflict** before deciding which to keep. Use `git show main:<file>` to inspect the main branch version of a file:

```bash
git show main:<file> | sed -n 'START_LINE,END_LINEp'
```

When resolving:
- **Prefer the more refined / newer version** (usually `main` if it was updated after the feature branch diverged)
- **Keep feature branch additions** that are not superseded by `main` (new UI elements, new features)
- **Merge the best of both** when each side has value (e.g., main's improved labels + feature's new MiniStat)
- **Always verify the surrounding context** — read 20+ lines before and after the conflict to understand the method structure

After editing a conflicted file:

```bash
git add <file>
git rebase --continue
```

Set `GIT_EDITOR=true` to skip the commit message editor:

```bash
export GIT_EDITOR=true
export EDITOR=true
git rebase --continue
```

### 5. Validate the Result (Critical!)

**This is the step that was missed and caused a crash.** Do NOT skip this.

#### 5a. Check for remaining conflict markers

```bash
grep -rn "<<<<<<\|======\|>>>>>>" server/ src/
```

If any remain, resolve them before continuing.

#### 5b. Validate syntax

For JavaScript/TypeScript projects, check that the code parses:

```bash
# Check a specific file
node --check server/collectors/LlmProbe.js

# Or run the full build (catches TypeScript errors too)
npm run build
```

For Node.js ES modules, `node --check` will catch syntax errors like missing braces, unexpected tokens, etc.

#### 5c. Run tests (if available)

```bash
npm test
```

### 6. Deploy

```bash
bash deploy.sh
```

### 7. Verify the Deployment

**Do NOT assume the deploy succeeded because the exit code was 0.** The container may start and then crash on import.

```bash
# Check container is running
docker compose ps

# Check logs for errors (look for SyntaxError, TypeError, etc.)
docker compose logs --tail=50

# If the container is restarting, check the full log
docker compose logs --tail=200 | grep -i "error\|fatal\|exception"
```

If the service crashes:
1. Read the error from the logs
2. Fix the code
3. Re-deploy (`bash deploy.sh`)
4. Re-check logs

### 8. Push (if you have permissions)

```bash
git push origin <feature-branch>
```

If you get `Permission denied`, you need write access to the repo or must push to a fork.

## Lessons Learned

1. **Conflict resolution can silently drop code.** When a conflict spans a large block, the resolved version may be missing entire methods or code paths that existed in one side. Always diff the resolved file against both sides to verify nothing was lost.

2. **`git rebase --continue` does not validate syntax.** It only checks that conflict markers are gone. A file can be "clean" of markers but still have broken braces, missing method bodies, or lost imports.

3. **Always validate before deploying.** Run `node --check` on JS files or `npm run build` before deploying. A 5-second check saves 10 minutes of debugging a crashed container.

4. **Check logs after deploy.** A successful `deploy.sh` exit code does not mean the service is healthy. The container may start and crash on the first import. Always `docker compose logs --tail=50` after deploy.

5. **Use `git show main:<file>` to inspect the other side.** When resolving conflicts, you may need to see the full context of what main has, not just the conflict markers.

## Common Pitfalls

| Pitfall | How to Avoid |
|---------|-------------|
| Dropping entire methods during conflict resolution | Read 20+ lines of context around the conflict; diff against both sides |
| Deploying broken code | Run `node --check` or `npm run build` before deploy |
| Assuming deploy succeeded | Check `docker compose logs` after deploy |
| Forgetting to continue rebase after resolving all conflicts | `git rebase --continue` until it says "Successfully rebased" |
| Pushing to a repo you can't write to | Check `git remote -v` and verify write access first |
