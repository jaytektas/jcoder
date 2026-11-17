# Changes

## 0.6.9

- **grep can't hang on a network mount any more.** Searches skip sshfs,
  NFS, SMB and other network mounts below the search folder (the model is
  told which, and can search one by giving it as the path), and any search
  is stopped after 60 seconds with what it found so far. Running jcoder in
  `~` with a share mounted under it used to make a broad grep read the
  whole share over the network. `glob` skips network mounts too.
- **grep works like a search tool should.** By default it lists the
  files that match; `output: "content"` gives the lines, with `context`
  lines around each match, and `output: "count"` gives matches per file.
  `literal: true` searches for plain text, so `foo(` needs no escaping.
- **grep behaves the same whatever is installed.** Patterns are
  Perl/ripgrep style everywhere: without ripgrep, GNU grep used to read
  `\d` as the letter "d" and quietly find the wrong lines. Hidden files
  are skipped with every engine, and `.gitignore`d files are skipped by
  rg, and by git grep, which is used in a git repo when rg isn't installed.

## 0.6.8

- **"failed" means failed.** A shell command that exits non-zero is no
  longer shown in red or counted as failed: `grep` finding nothing, `ls`
  of a missing path or a `curl` that can't connect exit non-zero after
  running fine, and most "failed" lines were that. The model still sees
  the exit code. Red is kept for real failures: a command killed after
  the time limit, a tool error. Stopping the model (esc, ctrl+s) no
  longer marks the stopped tool calls as failed either.

## 0.6.7

- **Ctrl+S sends a message now.** While the model is working, Enter still
  queues your message; Ctrl+S stops the model and sends it straight away,
  ahead of anything already queued. With the model idle it's the same as
  Enter.
- **ask_user works with models that ask several questions at once.** Some
  models send `{"questions": [{question, options}, …]}`, the shape other
  coding agents use; jcoder read only `question`, so it showed an empty
  prompt and the turn hung. Now each question is asked in turn and the
  answers go back together. A call with no question gets an error that
  says what to send instead of a blank prompt.

## 0.6.6

- **grep no longer fails on a broad search over a big project.** Without
  `rg` installed, a pattern like `trigger` over a whole tree could print
  more than 64 MB, and the search was killed with just "grep failed". It
  now streams the output, keeps the first 300 matches (each cut to 300
  characters) and gives the total count. When it does fail, it says why.

## 0.6.5

- **Edit mode no longer asks before commands that only look.** `ls`,
  `cat`, `grep`, `rg`, `find`, `head`/`tail`, `wc`, `git
  status/log/diff/show` and the like run straight away, piped or chained
  together too. jcoder still asks if anything in the command could change
  something: another program, output written to a file, `$(…)` or
  backticks, or an option like `find -delete` or `sort -o`.

## 0.6.4

- **Sub-agents on other servers follow the mode you're in now.** They
  kept the mode from when the first one started, so switching to auto
  mid-session still left them asking before every command.

## 0.6.3

- **The model says what it's doing.** It writes a short sentence before
  each step and when it finds something that changes the plan, so the
  conversation reads as a running account instead of a long silent run
  of tool calls.
- **Shell commands say what they're for.** The bash tool takes a short
  description ("Run the tests"), shown on the live line while the
  command runs, with the command itself under it when you expand the
  summary or press ctrl+o. Without one, the command shows as before.

## 0.6.2

- **Summary lines light up under the mouse, like a link.** Hovering a
  `Ran 2 shell commands, read 3 files (click to expand)` line highlights
  it, so it's clear it can be clicked.
- **The summary still growing can be clicked open too.** While the model
  is still running quiet commands, its summary line under the
  conversation used to ignore clicks; it now opens in place, and stays
  open once it's done.
- A click that wobbles by a cell no longer turns into a text selection.

## 0.6.1

- **What the model is doing sits under the conversation.** The tool
  summary in progress, the running command and the spinner were pinned
  above the input, with a gap between them and the last message on a
  short conversation. They now follow the last line and move down as it
  grows; the input stays at the bottom.

## 0.6.0

- **jcoder now draws the whole window, like Claude Code's fullscreen
  renderer.** It keeps the conversation itself instead of printing it
  into the terminal's scrollback, so the window size is up to you and:
  - the **wheel** scrolls the conversation, as do **PgUp/PgDn**. When
    you're scrolled up, a **Jump to bottom (ctrl+End) ↓** pill shows,
    and sending a message goes back to the bottom;
  - **clicking** a `Ran 2 shell commands, read 3 files (click to
    expand)` line opens it in place, showing each command with the
    start of its output. Click again to close it. ctrl+o still shows
    everything;
  - **dragging** selects text, and letting go copies it to the
    clipboard (wl-copy, xclip or xsel, else the terminal). Shift+drag
    gives the terminal's own selection.

  The terminal is restored on exit, including on a crash or a kill.
  `"fullscreen": false` in `~/.jcoder/config.json` brings back the old
  scrollback mode.

## 0.5.13

- **Quiet tool calls fold into one line.** Commands, file reads, searches
  and web lookups no longer print one by one with their output. A run of
  them shows as a single line, such as `Ran 2 shell commands, read 3
  files (ctrl+o to expand)`, with failures counted in red. While they run,
  the command in progress shows below it. Edits, writes, to-dos and
  questions still show in full.
- **ctrl+o opens the transcript:** every tool call this session with its
  full command and everything it returned, scrolled to the end. Scroll
  with ↑↓, pgup/pgdn and g/G; esc, q or ctrl+o closes it. A resumed
  conversation's earlier calls are in it too.
- **Edits show as a real diff:** only the lines that changed, with their
  line numbers and three lines around them, removed lines on red and
  added on green, with an exact `+added -removed` count. New files show
  their first lines.
- **Syntax colours** for diffs, new-file previews and code blocks in
  replies (comments, strings, numbers, keywords, type names). Headings
  are coloured too.

## 0.5.12

- **Resuming picks up the current system prompt.** `jcoder -c` and
  `/resume` kept the prompt a conversation started with, so prompt fixes
  (like 0.5.11's) never reached an ongoing conversation. A resumed
  conversation now gets today's prompt. If the prompt changed, the server
  re-reads the conversation once on the first reply.

## 0.5.11

- **Fewer, bigger steps.** The prompt said nothing about working
  efficiently, and the logs showed it: 91% of steps made a single tool
  call, `bash` was used for nearly everything, and small probes went one
  per round trip. The system prompt (and the sub-agent's) now asks it to
  plan, batch independent reads and searches into one step, chain shell
  commands, use read_file/grep/glob to look at code, and stop exploring
  once it can act.
- **No more sleeping to wait.** The model had written about two hours of
  `sleep` into its commands. It's now told to run long jobs with
  `background` and use `bash_output` with `wait`, which returns as soon as
  there is output or the job ends.
- **Remote background processes don't hang the call.** Starting one with
  `ssh host "cmd &"` kept ssh open until the timeout killed it (31 times in
  the logs). The prompt and the bash tool now say to detach it:
  `nohup cmd > log 2>&1 < /dev/null &`.

## 0.5.10

- **No more minute-long stall after you type.** At the start of each turn
  jcoder dropped the thinking from every earlier step. That changed the
  prompt just after the system prompt, so the server re-read the whole
  conversation before it could answer: 66–121 s on a 110k–177k token
  session with Strata. Thinking now stays until the conversation is
  compacted, and the server reuses its cache.
- **One token count for the whole turn.** The status line shows
  `↓ 1.2k tokens` for everything the model has written this turn
  (thinking, text and tool calls, across every step), including while
  tools run. The `✓ Done` line shows it too. It used to count only
  thinking, restart at each step, and show tool calls in characters.

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
