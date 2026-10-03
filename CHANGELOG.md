# Changes

## 0.5.3

- **`slots`**: how many requests the main server runs at once. llama.cpp
  reports it; for one that doesn't (vLLM, SGLang, a hosted API, a load
  balancer) jcoder assumed 4 and nothing could raise it. Now set it.
- **`agentMaxTools`** (45): tool calls a sub-agent gets, told to wrap up at
  two thirds. Was fixed at 30/45; raise it for a bigger model or context.

## 0.5.2

- **You can see what agents are doing.** Each agent's line keeps its last
  tool and file on show while it thinks (`read_file src/parser.ts · thinking
  300 tokens`), and an agent waiting for a free slot says so instead of not
  showing at all.

## 0.5.1

- **`-c` and `/resume` show the whole conversation** as it was: every
  message in full, tool calls and their results, thinking when shown, even
  what compaction summarised. Before, only the last six messages, cut short.

## 0.5.0

- **`/setting`** lists every setting, and `/setting maxAgents 3` changes one
  and saves it. Most apply at once; the server, model and tools at the next
  start.

## 0.4.0

- **Agents on other machines.** `agentServers` lists other servers (say a
  fast small model on another box) for sub-agents; each agent goes to the
  first with a free slot, then the main server unless `agentsOnMain` is off.
- `maxAgents`: cap how many sub-agents run at once, or `0` to turn agents off.
- No more flicker: only the lines that changed are redrawn, each frame goes
  to the terminal in one write, and all spinners share one clock.

## 0.3.0

- **Advisors.** `ask_model` can use several remote models, with presets for
  Gemini, Groq, Cerebras, OpenRouter, NVIDIA and Claude: add a key and go.
  When one is busy, rate-limited or down, the next answers. `/advisors`
  tests them; `advisorTimeout` sets how long to wait. Replaces `askModel`.
- An advisor that ignores us (no answer, unreachable, bad key, or busy three
  times running) is dropped for the session, a day, week, month, year or for
  good, per `dropAdvisors`; timed and permanent drops are saved in the
  settings.
- **Sampling per model.** Set temperature and friends for each model, one
  set for thinking and one for not; jcoder sends them with every request.
  `/sampling` shows what's in use.
- **No more rewrite loops.** Redoing the same file or command four times in a
  row gets a nudge to stop; a sub-agent is told to wrap up at 30 tool calls
  and must report at 45.

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
- `ask_model` retries when the remote model is busy or rate-limited.
- Updates install from any kind of install. Web search is offered once a
  search server is set. Paths inside the project show relative to it.

## 0.1.0

First release.
