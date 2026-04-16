# pi-initiatives

Initiative and project tracker for [pi](https://pi.dev) — manage initiatives, todos, and PRs with a split-panel TUI and LLM-callable tools.

## Install

```bash
pi install git:github.com/affsantos/pi-initiatives
```

## Quick Start

```bash
# 1. Create your initiatives folder and teams
mkdir -p ~/Initiatives/"Engineering"
mkdir -p ~/Initiatives/"Product"

# 2. Start pi — use /initiatives to get started
pi
```

## Usage

| Command | Description |
|---------|-------------|
| `/initiatives` | Browse initiatives, manage todos, resume work |
| `/todos` | Quick access to todos for the active initiative |

| Tool | Description |
|------|-------------|
| `initiative_todo` | LLM-callable: list, add, toggle, claim, update todos and more |
| `initiative_create` | LLM-callable: create new initiatives |

## Features

- **Split-panel TUI** — browse initiatives on the left, see details/todos/PRs on the right
- **Todo management** — open → WIP → done states, assignees, tags, markdown bodies
- **WIP tracking** — timestamps on in-progress todos, stale detection after 24h
- **Session claiming** — lock a todo to your session, with file-level locking for concurrency
- **Resume modes** — quick-resume (hot files only) or full-resume (everything)
- **Initiative lifecycle** — active, in-progress, paused, blocked, cancelled, complete
- **New initiative wizard** — guided creation with team, type, priority, DRI, stakeholders, tags
- **PR tracking** — parsed from `## Pull Requests` section in index.md
- **Persistent widget** — shows active count, open todos, and current WIP in the status bar

## Configuration

The initiatives folder is resolved in order:

1. `pi-initiatives.dir` in `~/.pi/agent/settings.json`:
   ```json
   { "pi-initiatives": { "dir": "~/my/initiatives" } }
   ```
2. `PI_INITIATIVES_DIR` environment variable
3. Default: `~/Initiatives`

### Teams

Teams are auto-discovered from top-level subdirectories in your initiatives folder. Each subdirectory becomes a team:

```
~/Initiatives/
├── Engineering/        ← team
│   ├── Auth Revamp/    ← initiative
│   │   ├── index.md
│   │   └── todos.md
│   └── API v2/
│       ├── index.md
│       └── todos.md
└── Product/            ← team
    └── Q2 Planning/
        └── index.md
```

### Initiative Structure

Each initiative is a folder with:

- **`index.md`** — YAML frontmatter (status, type, priority, DRI, etc.) + description + PR links
- **`todos.md`** — Markdown checkboxes with metadata:
  ```markdown
  - [ ] Open task @assignee #tag ~id:a1b2c3d4
  - [~] In progress task ~id:e5f6a7b8 ~ts:2025-01-15T10:30
  - [x] Completed task ~id:c9d0e1f2
    Notes and details go here (indented)
  ```

## License

MIT
