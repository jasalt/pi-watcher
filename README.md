# Pi Watcher

Editor comment watch mode for `pi-coding-agent`.

`pi-watcher` watches project files for explicit `AI!`, `AI?`, and `AI` comments, then sends focused prompts into the active pi session. The initial scaffold provides the package shape, config path helpers, and `/watcher status`; parser/watcher/router milestones land next.

## Install

```bash
# Install globally
pi install git:github.com/vedang/pi-watcher

# Or install for just the current project
pi install -l git:github.com/vedang/pi-watcher
```

## Development

```bash
bun install
make doctor
make test
make check
make format
```

Local extension smoke test:

```bash
pi -e ./src/index.ts
# then run /watcher status
```

## Commands

```text
/watcher status              show watcher status
/watcher config              show effective config paths and values
/watcher start               enable watcher in project config
/watcher stop                disable watcher in project config
/watcher global start|stop   update global config
/watcher project start|stop  update project config
```

Bare `/watcher start` and `/watcher stop` write project config at `<cwd>/.pi/extensions/pi-watcher.json`.

## Config paths

Config precedence follows sibling pi extensions:

1. defaults
2. global config: `~/.pi/agent/pi-watcher.json`
3. project config: `<cwd>/.pi/extensions/pi-watcher.json`

Default config starts enabled:

```json
{
  "enabled": true
}
```

## Marker syntax target

Planned aider-compatible marker forms:

```ts
// AI! edit this code
// AI? answer this question
// AI context anchor only
```

`AI!` triggers code-edit requests. `AI?` triggers answers. Plain `AI` records context for the next actionable marker.
