# Changes

## 0.2.0

- **One-line install.** `curl -fsSL https://raw.githubusercontent.com/jaytektas/jcoder/master/install.sh | sh`
  installs jcoder for you alone, no root, and fetches a private Node.js if
  yours is missing or too old.
- **First-run setup.** No server configured? jcoder looks on the usual ports
  (llama.cpp, LM Studio, Ollama, vLLM), offers what it finds or asks for an
  address. `jcoder --setup` changes it.
- **Agents.** The model can hand a self-contained job to a sub-agent with a
  fresh context and get a report back. Several run at once, up to the
  server's slots.
- **Drag and drop.** Drop files on the terminal to attach them.
- Updates install from any kind of install. Web search is offered once a
  search server is set. Paths inside the project show relative to it.

## 0.1.0

First release.
