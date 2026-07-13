![pi-watcher banner](images/banner.png)

Editor comment watch mode for `pi-coding-agent`.

`pi-watcher` watches files in the current pi working directory for explicit `AI!`, `AI?`, and `AI.` comments. When you save a file with an actionable marker, it sends a focused prompt into the active pi session.

## Install

```bash
# Install globally
pi install git:github.com/vedang/pi-watcher

# Or install for only the current project
pi install -l git:github.com/vedang/pi-watcher
```

No `--watch` flag is needed. If the extension is installed and config does not disable it, watcher starts automatically when pi starts in an interactive working directory. In no-UI print mode, status and manual scan work, but live watching does not auto-start.

## Quick start

1. Start pi from your project root.
2. Add a comment in your editor:

   ```ts
   function label(value: string | null) {
     return value.trim(); // handle null AI!
   }
   ```

3. Save the file.
4. pi receives a user message with file path, line number, and surrounding snippet.
5. For `AI!`, pi should make focused edits. After the agent fully settles, `pi-watcher` removes the handled trigger comments by default.

## Marker syntax

Supported line-comment prefixes: `#`, `//`, `--`, and semicolon comments such as `;` or `;;;`.

```ts
// AI! edit this code
// explain this branch AI?
// AI. context anchor only
```

Markers are case-insensitive (`ai!`, `AI?`, `Ai.`) and may appear at the normalized comment start or at the end of a comment after whitespace. `OpenAI`, `-ai!`, `some-ai?`, and bare `AI` are ignored.

Marker behavior:

- `AI!`: edit request. Prompt tells pi to use normal read/edit/write tools; watcher removes handled trigger comment blocks after the run.
- `AI?`: question. Prompt tells pi to answer without editing unless comment explicitly asks for edits; watcher removes handled question comments after the run.
- `AI.`: context anchor. Included with next actionable `AI!` or `AI?` batch, but does not trigger a turn alone; watcher removes handled context anchors after the run when cleanup is enabled.

## Commands

```text
/watcher status              show watcher state, config paths, queue, last trigger
/watcher config              show effective config paths and values
/watcher start               enable watcher in project config and start now
/watcher stop                disable watcher in project config and stop now
/watcher scan                scan roots now for AI comments
/watcher clear               clear pending queue and processed marker ledger
/watcher retry               retry last processed/suppressed marker batch
/watcher global start|stop   update global config
/watcher project start|stop  update project config
```

Bare `/watcher start` and `/watcher stop` write project config at `<cwd>/.pi/extensions/pi-watcher.json`.

The footer status shows `watcher on`, `watcher off`, `watcher queued`, or `watcher dispatching`. In UI mode, a small widget also shows queued marker count and last trigger.

## Config

Config precedence:

1. defaults
2. global config: `~/.pi/agent/pi-watcher.json`
3. project config: `<cwd>/.pi/extensions/pi-watcher.json`

Project config wins over global config.

Default config:

```json
{
  "enabled": true,
  "scanOnStart": true,
  "roots": ["."],
  "include": ["**/*"],
  "ignore": [
    "**/.git/**",
    "**/.jj/**",
    "**/.pi/**",
    "**/.agents/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.cache/**"
  ],
  "maxFileBytes": 1048576,
  "debounceMs": 300,
  "contextLines": 12,
  "maxPromptBytes": 60000,
  "marker": "AI",
  "removeHandledMarkerComments": true,
  "busyPolicy": "queue_until_idle"
}
```

Example project override:

```json
{
  "enabled": true,
  "roots": ["src", "tests"],
  "ignore": ["**/fixtures/**"],
  "contextLines": 8
}
```

## Loop prevention

After pi dispatches an actionable marker, `pi-watcher` remembers the normalized comment intent and, by default, removes handled `AI!`, `AI?`, and related `AI.` context-anchor comments when the agent fully settles, including any automatic retry, compaction retry, or queued continuation. Inline marker comments are stripped while preserving code before the comment.

If cleanup is disabled or pi leaves the same handled marker comments in place, the watcher suppresses repeat dispatches. Change the comment text or run `/watcher retry` to dispatch them again.

## Risks and limits

- Only explicit `AI!` and `AI?` comments trigger turns.
- Large files over `maxFileBytes`, likely binary files, ignored directories, and paths outside configured roots are skipped.
- The parser handles common line-comment syntax, not every language-specific edge case.
- Prompts are capped by `maxPromptBytes`; if a batch is too large, pi may need to read files directly.
- Keep secrets out of marked snippets. Saved comments and surrounding context are sent to the active pi session.

## Development

```bash
make init
make doctor
make test
make check
make format
```

Local extension smoke test:

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-context-files --no-session -e ./src/index.ts -p "/watcher status"
```
