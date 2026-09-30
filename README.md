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

## Images

- **Ctrl+V** pastes an image from the clipboard (`wl-paste`, or `xclip` on X11)
  and puts `[image #1]` in the line. Delete the marker to drop the image.
- **Image paths** in a message are attached — quoted, `file://`, or with
  escaped spaces, as a terminal pastes a dragged-in file.
- **read_file** on a png/jpg/gif/webp/bmp shows the image to the model.

## Sessions and logs

`~/.jcoder/sessions/<id>.json` is the current conversation, rewritten after
each turn; `jcoder -c` and `/resume` load it. `<id>.log.jsonl` next to it is
the full record, only ever appended to: every message with the model's
thinking, tool calls and results, errors, and the summary each compaction
made. `/log` prints its path. Images are stored once in `~/.jcoder/images/`
and referenced from both.

## System prompt

The template is `prompts/system.md`. `/prompt edit` copies it to
`~/.jcoder/system.md`, which then replaces it. Placeholders: `{{cwd}}`,
`{{git}}`, `{{os}}`, `{{date}}`, `{{notes}}`. `/prompt` shows the result.
Changes take effect in a new conversation.

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
