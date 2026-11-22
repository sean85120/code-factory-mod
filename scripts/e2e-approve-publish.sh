#!/bin/sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d)
git init -q --bare -b main "$W/origin.git"
git init -q -b main "$W/repo"
cd "$W/repo"
git config user.email t@example.com
git config user.name t
git remote add origin "$W/origin.git"
echo hi > README.md
git add . && git commit -qm init && git push -q origin main
mkdir -p .factory
cat > .factory/settings.json <<'J'
{"baseBranch":"main","testCmd":["true"]}
J
printf '# Design\n\n## Decisions\n- x\n' > .factory/design.md
cat > .factory/todo.md <<'J'
# Todo

## T-001 [feature] Add login
- status: proposed
- how: a server-rendered form posting to /login, checked with bcrypt
- accept: a valid user lands on the dashboard; a wrong password shows an error
- tests: unit tests for the handler and an e2e test of the form
J
git checkout -q -b feature/x
echo "before: origin/main has .factory? $(git ls-tree -r --name-only origin/main | grep -c '^.factory/' || true)"
hook() {
  printf '{"hook_event_name":"UserPromptSubmit","cwd":"%s","session_id":"e2e","prompt":"$factory-approve"}' "$W/repo" | PLUGIN_DATA="$W/data" node --experimental-strip-types "$ROOT/codex/hook.ts" 2>/dev/null
}
hook
echo
echo "--- after"
git fetch -q origin
echo "origin/main files:"; git ls-tree -r --name-only origin/main
echo "origin/main todo status: $(git show origin/main:.factory/todo.md | grep status)"
echo "current branch: $(git branch --show-current); status:"; git status --short
echo "origin log:"; git --git-dir="$W/origin.git" log --oneline main
echo "leftover index files: $(ls .git | grep -c 'factory-design' || true)"
echo "--- refused push (pre-receive hook rejects)"
printf '#!/bin/sh\necho no-direct-push >&2\nexit 1\n' > "$W/origin.git/hooks/pre-receive"; chmod +x "$W/origin.git/hooks/pre-receive"
git --git-dir="$W/origin.git" update-ref -d refs/heads/main
git --git-dir="$W/origin.git" update-ref refs/heads/main "$(git rev-parse HEAD)"
git fetch -q origin
echo "origin log before:"; git --git-dir="$W/origin.git" log --oneline main
hook
echo
echo "origin log after refusal:"; git --git-dir="$W/origin.git" log --oneline main
echo "leftover index files: $(ls .git | grep -c 'factory-design' || true)"
