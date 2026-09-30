# jcoder

A coding agent for a local OpenAI-compatible LLM server (llama.cpp first).

Built to make the most of a local model:

- **Small prompt.** System prompt + tools is ~2k tokens.
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

The input sits at the bottom; everything above is normal terminal
scrollback. `/` lists commands as you type, `@` completes file paths (the
file's text, an image, or a directory listing goes to the model with the
message). Messages typed while the model works are queued.

Keys: Esc stops the model · Shift+Tab cycles the mode · Ctrl+T shows or hides
its thinking · Ctrl+V pastes an image · `\` + Enter (or Alt+Enter, Ctrl+J)
for a new line · Up/Down for history · Ctrl+C twice or Ctrl+D quits.

## Tools

| tool | |
|---|---|
| `read_file` `write_file` `edit_file` | files; `read_file` also shows images to the model |
| `bash` | commands; `background: true` starts a job and returns at once |
| `bash_output` `bash_stop` | read a background job's new output, stop it (jobs stop when jcoder exits) |
| `grep` `glob` | search contents, find files |
| `web_search` `web_fetch` | SearXNG search (`searchUrl`), a page's main text |
| `todo` | the model's checklist for a multi-step task, shown above the input |
| `ask_user` | the model asks you something, with options, mid-task |
| `ask_model` | a second opinion from a remote model — only offered when `askModel.apiKey` is set |

### Asking Gemini

Get a free API key at https://aistudio.google.com/apikey and put it in the
settings file (or set `GEMINI_API_KEY`):

    "askModel": {
      "name": "Gemini",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "apiKey": "YOUR KEY",
      "model": "gemini-3.8-flash"
    }

Any OpenAI-compatible API works the same way. The remote model sees only
the question the local model writes, never the project or conversation.

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

## Effort

How hard the model thinks. llama.cpp caps the thinking at the budget
(`reasoning_budget_tokens`) and then makes the model answer, so a model
that starts thinking in circles can't eat the whole reply. Other servers
get `reasoning_effort` (low/medium/high) instead. `off` turns thinking off
through the chat template without touching the prompt, so the server's
cache is kept. The cap works with models whose thinking llama.cpp
recognises (Qwen3.x, DeepSeek-R1 style and similar).

## Settings

`~/.jcoder/config.json` (or `$JCODER_CONFIG`). It's written with every
setting and its default on first run, and new settings are added to it, so
it always shows what there is:

| key | default | |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8099` | server root, without `/v1` |
| `model` | first listed | model id |
| `apiKey` | | bearer token, if the server wants one |
| `contextWindow` | 32768 | used when the server doesn't report it (llama.cpp does) |
| `effort` | `high` | `/effort`: `off` no thinking · `low` 512 · `medium` 2048 · `high` 8192 thinking tokens a reply · `max` no limit |
| `showThinking` | false | `/thoughts`, Ctrl+T |
| `mode` | `edit` | `ro` read-only · `edit` edits freely, asks before commands · `auto` asks nothing |
| `maxToolChars` | 24000 | tool results longer than this are cut |
| `checkUpdates` | true | look for new GitHub releases once a day and offer them; `/update` checks any time |
| `bashTimeout` | 120 | seconds a command may run unless the model asks for longer (max 600) |
| `searchUrl` | `http://127.0.0.1:8888` | SearXNG server for `web_search`; empty turns it off |
| `compactAt` | 0.85 | share of the context that triggers compaction |
| `extraBody` | `{}` | merged into every request, e.g. sampling params |

## Notes

`~/.jcoder/JCODER.md` and the project's `JCODER.md` (or `AGENTS.md`) are
added to the system prompt. Keep them short: they're sent with every request.

## Licence

Copyright (C) 2026 Jason Roughley

jcoder is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE).

