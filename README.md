# pi-initiatives

Initiative and project tracker for [Pi](https://pi.dev) — organize work as folders and markdown files, browse it in a fast split-panel TUI, and manage initiatives and todos through both commands and LLM-callable tools.

## Why this package?

`pi-initiatives` gives Pi a lightweight, file-based system for tracking ongoing work:

- browse initiatives in a dedicated `/initiatives` UI
- create new initiatives with a guided wizard
- manage todos with stable IDs, WIP state, assignees, tags, and notes
- resume work quickly from the most relevant files
- keep everything in plain markdown on disk

No database, no SaaS backend, no lock-in — just folders, `index.md`, and `todos.md`.

## Install

### From npm

```bash
pi install npm:pi-initiatives
```

### From GitHub

```bash
pi install git:github.com/affsantos/pi-initiatives
```

## Quick Start

1. Start Pi
2. Run:

```text
/initiatives
```

On first run, `pi-initiatives` will guide you through:

- choosing an initiatives root folder
- creating one or more team/department folders
- optionally creating your first initiative immediately

If you prefer to set things up manually, you can still do:

```bash
mkdir -p ~/Initiatives/"Engineering"
mkdir -p ~/Initiatives/"Product"
pi
```

Then inside Pi:

```text
/initiatives
```

## Features

- **First-run onboarding** — friendly setup flow for new users
- **Split-panel TUI** — browse initiatives on the left, see details, todos, and PRs on the right
- **File-based storage** — initiatives live as normal folders and markdown files
- **Guided initiative creation** — team, type, priority, DRI, stakeholders, description, tags
- **Todo management** — open → WIP → done states, assignees, tags, session claims, markdown bodies
- **Stable todo IDs** — operate on todos safely even when line numbers shift
- **WIP freshness tracking** — stale WIP detection after 24 hours
- **Resume modes** — quick resume for hot files, or full resume for all markdown files
- **PR tracking** — parsed from the `## Pull Requests` section in `index.md`
- **Persistent widget** — active initiative count, open todos, and current WIP in Pi’s status area

## Commands

| Command | Description |
|---------|-------------|
| `/initiatives` | Browse initiatives, create new ones, manage status, todos, PR links, and resume work |
| `/todos` | Quick access to todos for the active initiative |

## Tools

| Tool | Description |
|------|-------------|
| `initiative_todo` | LLM-callable tool to list, add, start, toggle, update, claim, release, append, and delete todos, plus initiative status actions |
| `initiative_create` | LLM-callable tool to create a new initiative on disk |

## How it stores data

Each initiative is a folder inside a top-level team/department folder:

```text
~/Initiatives/
├── Engineering/
│   ├── Auth Revamp/
│   │   ├── index.md
│   │   └── todos.md
│   └── API v2/
│       ├── index.md
│       └── todos.md
└── Product/
    └── Q2 Planning/
        └── index.md
```

### `index.md`

Holds the initiative metadata and overview, including fields like:

- type
- status
- team
- owner / DRI
- stakeholders
- priority
- tags
- summary / description
- optional pull requests section

### `todos.md`

Stores markdown checkboxes with metadata:

```markdown
- [ ] Open task @assignee #tag ~id:a1b2c3d4
- [~] In progress task ~id:e5f6a7b8 ~ts:2025-01-15T10:30
- [x] Completed task ~id:c9d0e1f2
  Notes and details go here (indented)
```

Because everything is stored on disk, your initiatives and todos persist across Pi restarts and machine reboots.

## Configuration

The initiatives root folder is resolved in this order:

1. `pi-initiatives.dir` in `~/.pi/agent/settings.json`
2. `PI_INITIATIVES_DIR` environment variable
3. default: `~/Initiatives`

Example `settings.json`:

```json
{
  "pi-initiatives": {
    "dir": "~/my/initiatives"
  }
}
```

### Teams / departments

Top-level subdirectories under the initiatives root are treated as teams or departments. They are just an organizational layer.

Example:

```text
~/Initiatives/
├── Engineering/
├── Product/
└── Data Platform/
```

## Typical workflow

1. Run `/initiatives`
2. Create or select an initiative
3. Add or claim todos
4. Resume work with quick-resume or full-resume
5. Update status as the work progresses
6. Track PRs in `index.md`

## Publishing / sharing

If you publish this package to npm, others can install it with:

```bash
pi install npm:pi-initiatives
```

Or directly from GitHub:

```bash
pi install git:github.com/affsantos/pi-initiatives
```

## License

MIT
