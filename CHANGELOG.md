# Changes

## 0.5.9

- **A dropped connection is retried once.** When the server closed the
  connection before sending anything (restarting, or failing on the
  request), jcoder showed `fetch failed` and the turn stopped until you
  typed something. It now says so and tries again once, three seconds
  later. Nothing is retried after output has started, so nothing shows
  twice.

## 0.5.8

- **The model keeps its train of thought through a long turn.** jcoder sent
  the model's steps back without the thinking behind them, so after many
  tool calls it had to work out from scratch what it was doing, and could
  latch onto an old question and answer it again. Its thinking now goes
  back with each step until the turn ends (as `reasoning_content`; older
  turns' is dropped to save context). Replaying a session that went wrong
  this way, the model stayed on task with it and lost track without it.
  It costs context, so long turns compact sooner. **`keepThinking`** (on)
  turns it off for a server that rejects the field.

## 0.5.7

- **A crash mid-turn no longer loses the turn.** The conversation was only
  saved when a turn finished, so if jcoder died during a long one, `-c`
  brought back the state from before it. It's now saved after every round
  of tool calls, and written so a crash mid-write can't leave half a file.
- **After compacting mid-turn the model answers the right message.** The
  summary ended with "the user's latest request … carry on with it", which
  a model deep in a long turn could take for the newest message and answer
  again. It now says that request came before the cut, and that the newest
  message is the one to answer.

## 0.5.6

- **`/btw <question>`**: ask something on the side while the model works.
  The answer shows in a box above the input (esc closes it); the model
  carries on, and neither the question nor the answer goes into the
  conversation. It can't use tools. On a one-slot server it waits for the
  current reply to finish.
- **Times read as hours, minutes and seconds**: `8m 26s`, `3h 14m 12s`
  instead of `506s`, on the spinner, agent lines, "Done in" and jobs.

## 0.5.5

- **Queued messages reach the model mid-turn.** What you type while the
  model works used to wait until the whole turn was over. Now it goes in
  after the next round of tool calls, so you can steer the model while it
  works. Several queued messages go together as one. Once the model is
  writing its final answer, a message still waits for the next turn.

## 0.5.4

- **No more running out of memory.** jcoder left waiting (a question, a
  long command) ran the heap out after a few hours: React's development
  build kept a timing record for every redraw of the spinner, and the
  live area's measuring held on to two updates per frame. jcoder now loads
  React's production build and only measures when the size changes. Your own
  `NODE_ENV` still reaches the commands it runs.

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
