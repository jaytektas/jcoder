#!/bin/sh
# jcoder installer — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
#
#   curl -fsSL https://raw.githubusercontent.com/jaytektas/jcoder/master/install.sh | sh
#
# Installs jcoder for you alone, no root needed:
#   ~/.local/share/jcoder   jcoder itself (and its own Node.js, if yours is missing or too old)
#   ~/.local/bin/jcoder     the command
# Run it again any time to reinstall. To remove jcoder:
#   rm -rf ~/.local/share/jcoder ~/.local/bin/jcoder     (your settings in ~/.jcoder stay)
set -eu

REPO="jaytektas/jcoder"
PACKAGE="${JCODER_PACKAGE:-https://github.com/$REPO/releases/latest/download/jcoder.tgz}"
NODE_MIN="${JCODER_NODE_MIN:-22}"
NODE_LINE="latest-v24.x"          # the Node.js LTS line a private copy comes from
HOME_DIR="$HOME/.local/share/jcoder"
BIN_DIR="$HOME/.local/bin"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\033[31mjcoder install: %s\033[0m\n' "$*" >&2; exit 1; }
# ask "question" y|n — yes/no from the terminal (stdin is this script when
# piped from curl). With no terminal, the default answer is taken.
ask() {
  if { true </dev/tty; } 2>/dev/null; then
    printf '%s ' "$1" >/dev/tty
    read -r reply </dev/tty || reply=""
  else
    reply=""
  fi
  [ -n "$reply" ] || reply=$2
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}
fetch() { curl -fsSL --retry 2 "$@"; }

command -v curl >/dev/null || fail "needs curl"
command -v tar >/dev/null || fail "needs tar"

bold "Installing jcoder"

# --- Node.js -----------------------------------------------------------------
node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MIN" ]; }

NODE=""
if [ -x "$HOME_DIR/node/bin/node" ] && node_ok "$HOME_DIR/node/bin/node"; then
  NODE="$HOME_DIR/node/bin/node"
elif command -v node >/dev/null && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
  note "Node.js $("$NODE" -v) found"
else
  if command -v node >/dev/null; then note "Your Node.js is $(node -v); jcoder needs $NODE_MIN or later."
  else note "jcoder runs on Node.js, which isn't installed."; fi
  ask "Download Node.js for jcoder's own use (into $HOME_DIR/node, ~50 MB)? [Y/n]" y \
    || fail "install Node.js $NODE_MIN or later (https://nodejs.org), then run this again"

  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) fail "unsupported system $(uname -s)" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail "unsupported CPU $(uname -m)" ;; esac
  base="https://nodejs.org/dist/$NODE_LINE"
  file=$(fetch "$base/SHASUMS256.txt" | awk -v want="-$os-$arch.tar.gz" '$2 ~ want"$" {print $2; exit}')
  [ -n "$file" ] || fail "no Node.js download for $os-$arch"
  sum=$(fetch "$base/SHASUMS256.txt" | awk -v f="$file" '$2 == f {print $1}')

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  note "downloading $file"
  fetch -o "$tmp/$file" "$base/$file"
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/$file" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1); fi
  [ "$got" = "$sum" ] || fail "the Node.js download didn't match its checksum"
  rm -rf "$HOME_DIR/node"
  mkdir -p "$HOME_DIR/node"
  tar -xzf "$tmp/$file" -C "$HOME_DIR/node" --strip-components=1
  NODE="$HOME_DIR/node/bin/node"
  note "Node.js $("$NODE" -v) installed for jcoder"
fi
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM=npm

# --- jcoder ------------------------------------------------------------------
note "installing the latest jcoder release"
mkdir -p "$HOME_DIR" "$BIN_DIR"
PATH="$(dirname "$NODE"):$PATH" "$NPM" install -g --prefix "$HOME_DIR" --no-fund --no-audit --no-update-notifier --loglevel=error "$PACKAGE" >/dev/null \
  || fail "npm couldn't install $PACKAGE"

# The command runs jcoder with the Node.js chosen above, whatever is first on PATH later.
rm -f "$BIN_DIR/jcoder"
cat >"$BIN_DIR/jcoder" <<EOF
#!/bin/sh
exec "$NODE" "$HOME_DIR/lib/node_modules/jcoder/dist/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/jcoder"
version=$("$BIN_DIR/jcoder" --version) || fail "jcoder didn't start"
note "$version installed"

# --- PATH --------------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    case "${SHELL:-}" in */zsh) rc="$HOME/.zshrc" ;; */fish) rc="" ;; *) rc="$HOME/.bashrc" ;; esac
    line='export PATH="$HOME/.local/bin:$PATH"'
    if [ -n "$rc" ] && ask "Add ~/.local/bin to your PATH in $rc? [Y/n]" "$([ -t 0 ] || { true </dev/tty; } 2>/dev/null && echo y || echo n)"; then
      printf '\n# jcoder\n%s\n' "$line" >>"$rc"
      note "added; open a new terminal (or: . $rc)"
    else
      note "~/.local/bin isn't on your PATH. Add this to your shell's startup file:"
      note "  $line"
    fi
    ;;
esac

echo
bold "Done. In the project you want to work on, run:  jcoder"
note "It finds your model server (llama.cpp, LM Studio, Ollama, vLLM) or asks where it is."
