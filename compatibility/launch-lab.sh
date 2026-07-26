#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: compatibility/launch-lab.sh CLIENT /absolute/path/to/official-client" >&2
  exit 2
fi

SC_LAB_CLIENT="$1"
SC_LAB_EXECUTABLE="$2"
case "${SC_LAB_CLIENT}" in
  claude-code|codex|gemini-cli|opencode|vscode-copilot|cline) ;;
  *)
    echo "compatibility-lab: unsupported core client ${SC_LAB_CLIENT}" >&2
    exit 2
    ;;
esac

if [[ "${SC_LAB_EXECUTABLE}" != /* || ! -x "${SC_LAB_EXECUTABLE}" || -L "${SC_LAB_EXECUTABLE}" ]]; then
  echo "compatibility-lab: client must be an absolute executable regular path, not a symlink" >&2
  exit 2
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "compatibility-lab: tmux is required" >&2
  exit 2
fi

SC_LAB_ROOT="$(mktemp -d "/tmp/supercollab-compat-${SC_LAB_CLIENT}.XXXXXX")"
SC_LAB_HOME="${SC_LAB_ROOT}/home"
SC_LAB_WORKTREE="${SC_LAB_ROOT}/worktree"
SC_LAB_CONFIG="${SC_LAB_HOME}/.supercollab/config.json"
SC_LAB_SESSION="sc-${SC_LAB_CLIENT}-$(date +%s)-${BASHPID}"
mkdir -p "${SC_LAB_HOME}" "${SC_LAB_WORKTREE}"
chmod 700 "${SC_LAB_ROOT}" "${SC_LAB_HOME}" "${SC_LAB_WORKTREE}"

SC_LAB_PATH="$(dirname "${SC_LAB_EXECUTABLE}"):/usr/local/bin:/usr/bin:/bin"
tmux new-session -d -s "${SC_LAB_SESSION}" -c "${SC_LAB_WORKTREE}" \
  env -i \
  HOME="${SC_LAB_HOME}" \
  PATH="${SC_LAB_PATH}" \
  TERM="${TERM:-xterm-256color}" \
  XDG_CACHE_HOME="${SC_LAB_HOME}/.cache" \
  XDG_CONFIG_HOME="${SC_LAB_HOME}/.config" \
  XDG_DATA_HOME="${SC_LAB_HOME}/.local/share" \
  SUPERCOLLAB_CONFIG="${SC_LAB_CONFIG}" \
  SUPERCOLLAB_WORKDIR="${SC_LAB_WORKTREE}" \
  bash --noprofile --norc

cat <<EOF
compatibility-lab: ready
client: ${SC_LAB_CLIENT}
executable: ${SC_LAB_EXECUTABLE}
session: ${SC_LAB_SESSION}
root: ${SC_LAB_ROOT}
worktree: ${SC_LAB_WORKTREE}
config: ${SC_LAB_CONFIG}
attach: tmux attach-session -t ${SC_LAB_SESSION}

The session inherits no cloud keys, npm credentials, SSH agent, Git config, or
existing SuperCollab state. Authenticate the host interactively only if the
test requires it. Preserve the directory until evidence is reviewed.
EOF
