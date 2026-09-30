# jcoder

A coding agent for a local OpenAI-compatible LLM server (llama.cpp first).

Built to make the most of a local model:

- **Small prompt.** System prompt + tools is ~1.2k tokens.
- **Append-only history.** Nothing already sent is ever rewritten, so the
  server reuses its cache and a long session doesn't reprocess from scratch.
- **Old thinking isn't sent back.** The model's reasoning is shown (or not)
  but never goes back into the context.
- **No output cap** beyond what fits in the context.
- **Tool output is capped** to head + tail; the full text is saved to
  `~/.jcoder/tmp/` where the model can read or grep it.
- **Compacts only when nearly full** (85% by default), reusing the cache for
  the summary request.

## Use

    npm install && npm run build
    ln -s "$PWD/dist/index.js" ~/.local/bin/jcoder

    jcoder              start
    jcoder -c           continue the last conversation in this directory
    jcoder -p "..."     one request, then exit

Esc stops the model. Ctrl+T shows or hides its thinking. `/help` lists the
commands.

## Settings

`~/.jcoder/config.json` (or `$JCODER_CONFIG`):

| key | default | |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8099` | server root, without `/v1` |
| `model` | first listed | model id |
| `apiKey` | | bearer token, if the server wants one |
| `contextWindow` | 32768 | used when the server doesn't report it (llama.cpp does) |
| `thinking` | true | `/think` |
| `showThinking` | false | `/thoughts`, Ctrl+T |
| `mode` | `edit` | `ro` read-only · `edit` edits freely, asks before commands · `auto` asks nothing |
| `maxToolChars` | 24000 | tool results longer than this are cut |
| `compactAt` | 0.85 | share of the context that triggers compaction |
| `extraBody` | `{}` | merged into every request, e.g. sampling params |

## Notes

`~/.jcoder/JCODER.md` and the project's `JCODER.md` (or `AGENTS.md`) are
added to the system prompt. Keep them short: they're sent with every request.
