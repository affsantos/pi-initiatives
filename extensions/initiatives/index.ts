/**
 * Initiative Tracker extension for pi.
 *
 * Provides:
 * - `/initiatives` command: interactive split-panel TUI to browse and resume initiatives
 * - `initiative_todo` tool: LLM-callable tool to manage todos per initiative
 * - `initiative_create` tool: LLM-callable tool to create new initiatives
 * - Persistent widget showing active initiative count + open todos
 *
 * Configuration (checked in order):
 * 1. `pi-initiatives.dir` in ~/.pi/agent/settings.json
 * 2. `PI_INITIATIVES_DIR` environment variable
 * 3. Default: ~/Initiatives
 *
 * Teams are auto-discovered from top-level subdirectories in the initiatives folder.
 * Each subdirectory becomes a team. Create your first team folder to get started:
 *   mkdir -p ~/Initiatives/"My Team"
 *
 * Resume behavior is allowlist-based, not recursive:
 * - default hot files: `index.md`, `brief.md` (if present), `todos.md`
 * - optional warm files can be declared in frontmatter via `optional_files`
 * - archive/history folders are ignored by default
 *
 * Each initiative is a folder containing:
 * - `index.md` with YAML frontmatter (type, status, team, owner, dri, stakeholders, priority, etc.)
 * - `todos.md` with markdown checkboxes (optional, created on first todo)
 *
 * Todos format in todos.md:
 *   - [ ] Do the thing @assignee #tag ~id:a1b2c3d4
 *     Body text / notes (2-space indented under the checkbox)
 *   - [x] Done thing @assignee #tag ~id:e5f6a7b8
 *
 * Todos are addressed by stable IDs (~id:hex8). Line numbers are supported as fallback.
 * File-level locking prevents concurrent modifications to todos.md.
 */
import { DynamicBorder, copyToClipboard, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	Container,
	type Focusable,
	Input,
	Key,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	TUI,
	fuzzyMatch,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import crypto from "node:crypto";
import os from "node:os";

function whoami(): string {
	const name = os.userInfo().username;
	// Capitalize: "john.doe" → "John Doe"
	return name.replace(/[._-]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Configuration ───────────────────────────────────────────────────────────

interface TeamDef {
	display: string;
	slug: string;
	folder: string;
}

function getInitiativesDir(): string {
	// 1. Check settings.json
	const settingsPath = path.join(homedir(), ".pi", "agent", "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			const dir = settings?.["pi-initiatives"]?.dir;
			if (typeof dir === "string") {
				const expanded = dir.startsWith("~/") ? path.join(homedir(), dir.slice(2)) : dir;
				if (existsSync(expanded)) return expanded;
			}
		} catch { /* ignore */ }
	}

	// 2. Check environment variable
	if (process.env.PI_INITIATIVES_DIR && existsSync(process.env.PI_INITIATIVES_DIR)) {
		return process.env.PI_INITIATIVES_DIR;
	}

	// 3. Default
	return path.join(homedir(), "Initiatives");
}

function discoverTeams(initiativesDir: string): TeamDef[] {
	if (!existsSync(initiativesDir)) return [];
	const teams: TeamDef[] = [];
	try {
		for (const name of readdirSync(initiativesDir)) {
			if (name.startsWith("_") || name.startsWith(".")) continue;
			const fullPath = path.join(initiativesDir, name);
			try {
				if (!statSync(fullPath).isDirectory()) continue;
			} catch { continue; }
			teams.push({
				display: name,
				slug: name.toLowerCase().replace(/[\s_]+/g, "-"),
				folder: name,
			});
		}
	} catch { /* dir unreadable */ }
	return teams.sort((a, b) => a.display.localeCompare(b.display));
}

let INITIATIVES_DIR = getInitiativesDir();
let INITIATIVE_TEAMS: TeamDef[] = discoverTeams(INITIATIVES_DIR);

const INITIATIVE_TYPES = [
	{ value: "project", label: "📁 project", description: "Multi-step deliverable with concrete output" },
	{ value: "exploration", label: "🔍 exploration", description: "Investigation or analysis" },
	{ value: "request", label: "📝 request", description: "Stakeholder ask or ad-hoc work" },
] as const;

const INITIATIVE_PRIORITIES = [
	{ value: "high", label: "🔴 high" },
	{ value: "medium", label: "🟡 medium" },
	{ value: "low", label: "🟢 low" },
] as const;

// ─── Initiative Types ────────────────────────────────────────────────────────

interface Initiative {
	name: string;
	team: string;
	folderPath: string;
	type: string;
	status: string;
	owner: string;
	dri: string;
	stakeholders: string[];
	priority: string;
	started: string;
	updated: string;
	tags: string[];
	summary: string;
	resumeFiles: string[];
	optionalFiles: string[];
	ignorePaths: string[];
	todos: Todo[];
	prs: PullRequest[];
}

// ─── Pull Request Types ──────────────────────────────────────────────────────

interface PullRequest {
	number: string;        // e.g., "7078"
	title: string;         // e.g., "Claimini backfill for Damage Cost Monitoring"
	url: string;           // full GitHub URL
	status: string;        // e.g., "Merged 2026-02-18", "Open", "Draft"
	repo: string;          // e.g., "my-org/my-repo"
}

// ─── Todo Types ──────────────────────────────────────────────────────────────

type TodoState = "open" | "wip" | "done";

interface Todo {
	id: string;             // stable 8-char hex (~id:a1b2c3d4), auto-assigned if missing
	line: number;           // 0-based line index of the header in todos.md
	done: boolean;          // legacy convenience: true if state === "done"
	state: TodoState;       // open = [ ], wip = [~], done = [x]
	title: string;          // raw title text without metadata
	body: string;           // markdown body (indented lines below checkbox), may be empty
	assignee: string;       // @name or empty
	tag: string;            // #tag or empty
	session: string;        // ~session:id or empty
	ts: string;             // ~ts:YYYY-MM-DDTHH:MM or empty — set when WIP starts
	raw: string;            // original header line
	initiative: string;     // initiative folder name
	team: string;           // team folder name
}

// ─── Todo ID Generation ─────────────────────────────────────────────────────

function generateTodoId(): string {
	return crypto.randomBytes(4).toString("hex");
}

function ensureId(todo: Todo): Todo {
	if (!todo.id) todo.id = generateTodoId();
	return todo;
}

// ─── Todo Locking ────────────────────────────────────────────────────────────

interface TodoLockInfo {
	pid: number;
	session: string;
	created_at: string;
}

const TODO_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function acquireTodoLock(folderPath: string, sessionId: string): Promise<(() => Promise<void>) | null> {
	const lockPath = path.join(folderPath, "todos.lock");
	const now = Date.now();

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(lockPath, "wx");
			const info: TodoLockInfo = {
				pid: process.pid,
				session: sessionId,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
			await handle.close();
			return async () => {
				try { await fs.unlink(lockPath); } catch {}
			};
		} catch (error: any) {
			if (error?.code !== "EEXIST") return null;

			// Lock exists — check if stale
			try {
				const stats = await fs.stat(lockPath);
				if (now - stats.mtimeMs > TODO_LOCK_TTL_MS) {
					await fs.unlink(lockPath).catch(() => {});
					continue; // retry
				}
			} catch {}

			return null; // lock held by another session
		}
	}
	return null;
}

async function withTodoLock<T>(
	folderPath: string,
	sessionId: string,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const release = await acquireTodoLock(folderPath, sessionId);
	if (!release) {
		return { error: "Could not acquire lock on todos.md — another session may be editing. Try again shortly." };
	}
	try {
		return await fn();
	} finally {
		await release();
	}
}

// ─── YAML Frontmatter Parsing ────────────────────────────────────────────────

interface Frontmatter {
	type?: string;
	status?: string;
	team?: string;
	owner?: string;
	dri?: string;
	stakeholders?: string[];
	priority?: string;
	started?: string;
	updated?: string;
	tags?: string[];
	resume_files?: string[];
	optional_files?: string[];
	ignore_paths?: string[];
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const fm: Frontmatter = {};
	let body = content;

	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
	if (!match) return { frontmatter: fm, body };

	body = content.slice(match[0].length);
	const yamlBlock = match[1];

	const lines = yamlBlock.split("\n");
	let currentKey = "";
	let currentList: string[] | null = null;

	for (const line of lines) {
		const listMatch = line.match(/^\s+-\s+(.+)/);
		if (listMatch && currentList !== null) {
			currentList.push(listMatch[1].trim());
			continue;
		}

		if (currentList !== null && currentKey) {
			(fm as any)[currentKey] = currentList;
			currentList = null;
		}

		const kvMatch = line.match(/^(\w+)\s*:\s*(.*)/);
		if (kvMatch) {
			currentKey = kvMatch[1];
			const value = kvMatch[2].trim();

			if (!value) {
				currentList = [];
			} else if (value.startsWith("[") && value.endsWith("]")) {
				(fm as any)[currentKey] = value
					.slice(1, -1)
					.split(",")
					.map((s: string) => s.trim())
					.filter(Boolean);
			} else {
				(fm as any)[currentKey] = value;
			}
		}
	}

	if (currentList !== null && currentKey) {
		(fm as any)[currentKey] = currentList;
	}

	return { frontmatter: fm, body };
}

function extractSummary(body: string): string {
	const lines = body.split("\n");
	let paragraphLines: string[] = [];
	let inParagraph = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (!inParagraph) {
			if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("- [[") || trimmed.startsWith("---")) {
				continue;
			}
			inParagraph = true;
		}

		if (inParagraph) {
			if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("## ")) {
				break;
			}
			paragraphLines.push(trimmed);
		}
	}

	const text = paragraphLines.join(" ").trim();
	if (text.length > 0) return text;
	return "No summary available.";
}

// ─── Todo Parsing ────────────────────────────────────────────────────────────

function parseTodoHeader(raw: string, lineIndex: number, initiative: string, team: string): Todo | null {
	const match = raw.match(/^- \[([ xX~])\] (.+)/);
	if (!match) return null;

	const marker = match[1];
	const state: TodoState = marker === "~" ? "wip" : marker === " " ? "open" : "done";
	const done = state === "done";
	let text = match[2].trim();

	// Extract ~id:xxxxxxxx
	let id = "";
	const idMatch = text.match(/~id:([a-f0-9]{8})/i);
	if (idMatch) {
		id = idMatch[1].toLowerCase();
		text = text.replace(/\s*~id:[a-f0-9]{8}/i, "").trim();
	}

	// Extract ~session:xxx
	let session = "";
	const sessionMatch = text.match(/~session:(\S+)/);
	if (sessionMatch) {
		session = sessionMatch[1];
		text = text.replace(/\s*~session:\S+/, "").trim();
	}

	// Extract ~ts:YYYY-MM-DDTHH:MM
	let ts = "";
	const tsMatch = text.match(/~ts:(\S+)/);
	if (tsMatch) {
		ts = tsMatch[1];
		text = text.replace(/\s*~ts:\S+/, "").trim();
	}

	// Extract @assignee
	let assignee = "";
	const assigneeMatch = text.match(/@(\w+)/);
	if (assigneeMatch) {
		assignee = assigneeMatch[1];
		text = text.replace(/\s*@\w+/, "").trim();
	}

	// Extract #tag (first one)
	let tag = "";
	const tagMatch = text.match(/#(\w[\w-]*)/);
	if (tagMatch) {
		tag = tagMatch[1];
		text = text.replace(/\s*#\w[\w-]*/, "").trim();
	}

	return {
		id,
		line: lineIndex,
		done,
		state,
		title: text,
		body: "",
		assignee,
		tag,
		session,
		ts,
		raw,
		initiative,
		team,
	};
}

function parseTodosFile(content: string, initiative: string, team: string): Todo[] {
	const todos: Todo[] = [];
	const lines = content.split("\n");
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const todo = parseTodoHeader(line, i, initiative, team);

		if (todo) {
			// Collect indented body lines following the header
			const bodyLines: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const nextLine = lines[j];
				// Stop at next todo header
				if (nextLine.match(/^- \[([ xX~])\] /)) break;
				// Accept indented lines (2+ spaces) or blank lines within the body
				if (nextLine.startsWith("  ") || nextLine.trim() === "") {
					bodyLines.push(nextLine);
					j++;
				} else {
					break;
				}
			}

			// Trim trailing blank lines from body
			while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
				bodyLines.pop();
			}

			// Remove 2-space indent from body lines
			todo.body = bodyLines.map(l => l.startsWith("  ") ? l.slice(2) : l).join("\n");

			// Auto-assign ID if missing
			ensureId(todo);

			todos.push(todo);
			i = j;
		} else {
			i++;
		}
	}

	return todos;
}

/** Legacy wrapper for backwards compat — parses header only, no body */
function parseTodoLine(raw: string, lineIndex: number, initiative: string, team: string): Todo | null {
	return parseTodoHeader(raw, lineIndex, initiative, team);
}

async function readTodos(folderPath: string, initiative: string, team: string): Promise<Todo[]> {
	const todosPath = path.join(folderPath, "todos.md");
	if (!existsSync(todosPath)) return [];
	try {
		const content = await fs.readFile(todosPath, "utf8");
		return parseTodosFile(content, initiative, team);
	} catch {
		return [];
	}
}

/**
 * Read todos, auto-assign any missing IDs, and persist if IDs were added.
 * This is the standard way to read todos — ensures every todo has a stable ID.
 */
async function readTodosWithIds(folderPath: string, initiative: string, team: string): Promise<Todo[]> {
	const todos = await readTodos(folderPath, initiative, team);
	// Check if any IDs were freshly generated (they always are by ensureId, but check raw)
	const needsPersist = todos.some(t => !t.raw.includes("~id:"));
	if (needsPersist && todos.length > 0) {
		await writeTodos(folderPath, todos);
	}
	return todos;
}

function serializeTodo(todo: Todo): string {
	const checkbox = todo.state === "wip" ? "[~]" : todo.state === "done" ? "[x]" : "[ ]";
	let line = `- ${checkbox} ${todo.title}`;
	if (todo.assignee) line += ` @${todo.assignee}`;
	if (todo.tag) line += ` #${todo.tag}`;
	if (todo.id) line += ` ~id:${todo.id}`;
	if (todo.session) line += ` ~session:${todo.session}`;
	if (todo.ts) line += ` ~ts:${todo.ts}`;

	// Append body as 2-space indented lines
	if (todo.body && todo.body.trim()) {
		const bodyLines = todo.body.split("\n").map(l => `  ${l}`);
		line += "\n" + bodyLines.join("\n");
	}

	return line;
}

function nowTimestamp(): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function isStaleWip(todo: Todo, hoursThreshold = 24): boolean {
	if (todo.state !== "wip" || !todo.ts) return false;
	const tsDate = new Date(todo.ts);
	if (isNaN(tsDate.getTime())) return false;
	const ageMs = Date.now() - tsDate.getTime();
	return ageMs > hoursThreshold * 60 * 60 * 1000;
}

async function writeTodos(folderPath: string, todos: Todo[]): Promise<void> {
	const todosPath = path.join(folderPath, "todos.md");
	const content = todos.map(serializeTodo).join("\n") + "\n";
	await fs.writeFile(todosPath, content, "utf8");
}

// ─── Initiative Frontmatter Helpers ──────────────────────────────────────────

const VALID_STATUSES = ["active", "in-progress", "paused", "blocked", "cancelled", "complete"] as const;
type InitiativeStatus = typeof VALID_STATUSES[number];

function todayDate(): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function updateFrontmatterFields(
	indexPath: string,
	updates: Record<string, string>,
): Promise<void> {
	const content = await fs.readFile(indexPath, "utf8");
	const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return;

	let yaml = match[1];
	for (const [field, value] of Object.entries(updates)) {
		const regex = new RegExp(`^(${field}:\\s*)(.+)$`, "m");
		if (yaml.match(regex)) {
			yaml = yaml.replace(regex, `$1${value}`);
		} else {
			yaml += `\n${field}: ${value}`;
		}
	}

	const updatedContent = content.replace(match[1], yaml);
	await fs.writeFile(indexPath, updatedContent, "utf8");
}

async function appendClosingNotes(indexPath: string, comment?: string): Promise<void> {
	let content = await fs.readFile(indexPath, "utf8");

	// Remove existing Closing Notes section if present (to avoid duplicates on re-complete)
	content = content.replace(/\n## Closing Notes\n[\s\S]*?(?=\n## |\n---|$)/, "");

	const date = todayDate();
	let section = `\n## Closing Notes\n\n**Completed ${date}.**`;
	if (comment && comment.trim()) {
		section += ` ${comment.trim()}`;
	}
	section += "\n";

	await fs.writeFile(indexPath, content.trimEnd() + "\n" + section, "utf8");
}

/** Find a todo by ID or fall back to line number */
function findTodo(todos: Todo[], id?: string, line?: number): Todo | undefined {
	if (id) {
		const normalized = id.toLowerCase().replace(/^todo-/i, "");
		return todos.find(t => t.id === normalized);
	}
	if (line !== undefined) {
		return todos.find(t => t.line === line);
	}
	return undefined;
}

/** Find the index of a todo in the array by ID or line */
function findTodoIndex(todos: Todo[], id?: string, line?: number): number {
	if (id) {
		const normalized = id.toLowerCase().replace(/^todo-/i, "");
		return todos.findIndex(t => t.id === normalized);
	}
	if (line !== undefined) {
		return todos.findIndex(t => t.line === line);
	}
	return -1;
}

// ─── Pull Request Parsing ────────────────────────────────────────────────────

function parsePullRequests(content: string): PullRequest[] {
	const prs: PullRequest[] = [];

	// Find the ## Pull Requests section
	const sectionMatch = content.match(/## Pull Requests\s*\n([\s\S]*?)(?=\n## |\n---|$)/);
	if (!sectionMatch) return prs;

	const section = sectionMatch[1];
	const lines = section.split("\n");

	for (const line of lines) {
		// Match: - [#number — title](url) — status
		// Also handle: - [#number - title](url) - status (with regular dashes)
		const match = line.match(/^-\s+\[#(\d+)\s*[—–-]\s*([^\]]+)\]\((https?:\/\/[^)]+)\)\s*[—–-]\s*(.+)/);
		if (match) {
			const url = match[3];
			// Extract repo from URL: https://github.com/org/repo/pull/123 → org/repo
			const repoMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
			prs.push({
				number: match[1],
				title: match[2].trim(),
				url,
				status: match[4].trim(),
				repo: repoMatch ? repoMatch[1] : "",
			});
			continue;
		}

		// Fallback: any markdown link to a github PR
		const fallback = line.match(/\[([^\]]+)\]\((https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)[^)]*)\)/);
		if (fallback) {
			const afterLink = line.slice(line.indexOf(")") + 1).trim();
			const statusMatch = afterLink.match(/^[—–-]\s*(.+)/);
			prs.push({
				number: fallback[4],
				title: fallback[1].replace(/^#\d+\s*[—–-]\s*/, "").trim(),
				url: fallback[2],
				status: statusMatch ? statusMatch[1].trim() : "",
				repo: fallback[3],
			});
		}
	}

	return prs;
}

// ─── Initiative Scanning ─────────────────────────────────────────────────────

async function scanInitiatives(): Promise<Initiative[]> {
	const initiatives: Initiative[] = [];
	// Re-resolve config on each scan so new folders / env changes are picked up
	INITIATIVES_DIR = getInitiativesDir();
	INITIATIVE_TEAMS = discoverTeams(INITIATIVES_DIR);
	if (!existsSync(INITIATIVES_DIR)) return initiatives;

	const teams = await fs.readdir(INITIATIVES_DIR);
	for (const team of teams) {
		const teamPath = path.join(INITIATIVES_DIR, team);
		const stat = await fs.stat(teamPath);
		if (!stat.isDirectory() || team.startsWith("_") || team.startsWith(".")) continue;

		const projects = await fs.readdir(teamPath);
		for (const project of projects) {
			const projectPath = path.join(teamPath, project);
			const projectStat = await fs.stat(projectPath);
			if (!projectStat.isDirectory()) continue;

			const indexPath = path.join(projectPath, "index.md");
			if (!existsSync(indexPath)) continue;

			try {
				const content = await fs.readFile(indexPath, "utf8");
				const { frontmatter: fm, body } = parseFrontmatter(content);
				const todos = await readTodos(projectPath, project, team);
				const prs = parsePullRequests(content);

				initiatives.push({
					name: project,
					team: team,
					folderPath: projectPath,
					type: fm.type ?? "project",
					status: fm.status ?? "unknown",
					owner: fm.owner ?? "",
					dri: fm.dri ?? "",
					stakeholders: fm.stakeholders ?? [],
					priority: fm.priority ?? "",
					started: fm.started ?? "",
					updated: fm.updated ?? "",
					tags: fm.tags ?? [],
					summary: extractSummary(body),
					resumeFiles: resolveResumeFiles(projectPath, fm.resume_files),
					optionalFiles: resolveOptionalFiles(projectPath, fm.optional_files, resolveResumeFiles(projectPath, fm.resume_files)),
					ignorePaths: resolveIgnorePaths(fm.ignore_paths),
					todos,
					prs,
				});
			} catch {
				// skip
			}
		}
	}
	return initiatives;
}

// ─── Initiative helpers ──────────────────────────────────────────────────────

const DEFAULT_RESUME_FILES = ["index.md", "brief.md", "todos.md"] as const;
const DEFAULT_OPTIONAL_FILES = ["milestones.md", "decisions.md"] as const;
const DEFAULT_IGNORE_PATHS = ["archive/", "notes/"] as const;

function findInitiative(initiatives: Initiative[], name: string): Initiative | undefined {
	const lower = name.toLowerCase();
	return initiatives.find(
		(i) => i.name.toLowerCase() === lower || i.name.toLowerCase().replace(/\s+/g, "-") === lower
	);
}

function normalizeRelativeMarkdownPath(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (path.isAbsolute(trimmed)) return null;
	const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
	if (normalized.startsWith("../") || normalized === "..") return null;
	if (!normalized.endsWith(".md")) return null;
	return normalized;
}

function normalizeRelativePathPrefix(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (path.isAbsolute(trimmed)) return null;
	const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
	if (normalized.startsWith("../") || normalized === "..") return null;
	return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function resolveResumeFiles(folderPath: string, configured?: string[]): string[] {
	const requested = configured && configured.length > 0 ? configured : [...DEFAULT_RESUME_FILES];
	const normalized = requested
		.map(normalizeRelativeMarkdownPath)
		.filter((v): v is string => Boolean(v));
	const existing = normalized.filter((rel) => existsSync(path.join(folderPath, rel)));
	return unique(existing);
}

function resolveOptionalFiles(folderPath: string, configured?: string[], resumeFiles?: string[]): string[] {
	const requested = configured && configured.length > 0 ? configured : [...DEFAULT_OPTIONAL_FILES];
	const normalized = requested
		.map(normalizeRelativeMarkdownPath)
		.filter((v): v is string => Boolean(v));
	const existing = normalized.filter((rel) => existsSync(path.join(folderPath, rel)));
	const resumeSet = new Set(resumeFiles ?? DEFAULT_RESUME_FILES);
	return unique(existing.filter((rel) => !resumeSet.has(rel)));
}

function resolveIgnorePaths(configured?: string[]): string[] {
	const requested = configured && configured.length > 0 ? configured : [...DEFAULT_IGNORE_PATHS];
	return unique(requested.map(normalizeRelativePathPrefix).filter((v): v is string => Boolean(v)));
}

function buildQuickResumePrompt(init: Initiative): string {
	const indexPath = path.join(init.folderPath, "index.md");
	const briefPath = path.join(init.folderPath, "brief.md");
	const todosPath = path.join(init.folderPath, "todos.md");
	const hasBrief = existsSync(briefPath);

	return `Quick-resume the "${init.name}" initiative. This is the recommended mode.\n\nRead these files first:\n- ${indexPath}${hasBrief ? `\n- ${briefPath}` : ""}\n- ${todosPath}\n\nImportant: from ${todosPath}, focus only on the active sections first — especially \"## Open\" and \"## WIP\". Do not read completed todo details unless they are truly necessary.\n\nDo not recursively read all markdown files in ${init.folderPath}/. Ignore archive/history by default unless needed later.\n\nThen provide a concise summary of:\n- current status\n- what's in progress or open now\n- what's remaining\n- blockers or open questions\n\nIf the hot files are insufficient, you may read optional warm files like milestones.md or decisions.md, but mention which extra files you used.`;
}

function buildFullResumePrompt(init: Initiative): string {
	return `Resume the "${init.name}" initiative in full-detail mode. Read all markdown files in ${init.folderPath}/ recursively, including archive/history files if present, and provide a summary of:\n- current status\n- what's been done\n- what's remaining\n- any open questions or blockers\n\nAlso mention any especially important historical context you found.`;
}

// ─── Status helpers ──────────────────────────────────────────────────────────

function statusIcon(status: string): string {
	switch (status) {
		case "complete": return "✓";
		case "active": return "●";
		case "blocked": return "⏸";
		case "paused": return "◐";
		case "cancelled": return "⛔";
		default: return "·";
	}
}

function statusColor(status: string): string {
	switch (status) {
		case "complete": return "dim";
		case "active": return "success";
		case "blocked": return "error";
		case "paused": return "warning";
		case "cancelled": return "dim";
		default: return "dim";
	}
}

function isActive(status: string): boolean {
	return status !== "complete" && status !== "cancelled";
}

function displayStatus(status: string): string {
	return status.charAt(0).toUpperCase() + status.slice(1);
}

function typeIcon(type: string): string {
	switch (type) {
		case "project": return "📁";
		case "exploration": return "🔍";
		case "request": return "📝";
		default: return "📄";
	}
}

// ─── Team Resolution ─────────────────────────────────────────────────────────

function resolveTeam(input: string): TeamDef | null {
	const lower = input.toLowerCase().replace(/[-_\s]+/g, "");
	for (const team of INITIATIVE_TEAMS) {
		const check = team.display.toLowerCase().replace(/[-_\s]+/g, "");
		const slugCheck = team.slug.replace(/-/g, "");
		if (lower === check || lower === slugCheck || lower === team.folder.toLowerCase().replace(/\s+/g, "")) return team;
	}
	return null;
}

// ─── Initiative Creation ─────────────────────────────────────────────────────

interface CreateInitiativeParams {
	teamFolder: string;
	teamSlug: string;
	name: string;
	type: string;
	priority: string;
	dri: string;
	stakeholders: string[];
	description: string;
	tags: string[];
}

async function createInitiativeOnDisk(params: CreateInitiativeParams): Promise<string> {
	const folderPath = path.join(INITIATIVES_DIR, params.teamFolder, params.name);

	if (existsSync(folderPath)) {
		throw new Error(`Initiative folder already exists: ${folderPath}`);
	}

	await fs.mkdir(folderPath, { recursive: true });

	const stakeholderYaml = params.stakeholders.length > 0
		? "stakeholders:\n" + params.stakeholders.map(s => `  - ${s.trim()}`).join("\n")
		: "stakeholders: []";

	const tagsYaml = params.tags.length > 0
		? `[${params.tags.map(t => t.trim()).join(", ")}]`
		: "[]";

	const today = todayDate();

	const content = `---
type: ${params.type}
status: active
team: ${params.teamSlug}
owner: ${whoami()}
dri: ${params.dri}
${stakeholderYaml}
priority: ${params.priority}
started: ${today}
updated: ${today}
tags: ${tagsYaml}
resume_files: [index.md, todos.md]
optional_files: [milestones.md, decisions.md]
ignore_paths: [archive/, notes/]
slack: []
---

${params.description}

## Quick Links

## Related Links

## Pull Requests
`;

	const indexPath = path.join(folderPath, "index.md");
	await fs.writeFile(indexPath, content, "utf8");

	return folderPath;
}

// ─── Widget ──────────────────────────────────────────────────────────────────

function updateWidget(ctx: ExtensionContext, initiatives: Initiative[], focused: Initiative | null = null, todo: Todo | null = null) {
	if (focused) {
		// Focused mode: show the active initiative's details
		const icon = statusIcon(focused.status);
		const openCount = focused.todos.filter((t) => t.state === "open").length;
		const wipCount = focused.todos.filter((t) => t.state === "wip").length;
		const staleCount = focused.todos.filter((t) => isStaleWip(t)).length;
		const doneCount = focused.todos.filter((t) => t.state === "done").length;
		const prCount = focused.prs.length;

		const parts: string[] = [];
		parts.push(`${icon} ${displayStatus(focused.status)}`);
		if (wipCount > 0) parts.push(`${wipCount} wip`);
		if (openCount > 0) parts.push(`${openCount} open`);
		if (doneCount > 0) parts.push(`${doneCount} done`);
		if (prCount > 0) parts.push(`${prCount} PRs`);
		if (staleCount > 0) parts.push(`!! ${staleCount} stale`);

		// Capture data for closure — build line inside render for width awareness
		const focusedName = focused.name;
		const partsSnapshot = [...parts];
		const todoTitle = todo ? todo.title : null;

		ctx.ui.setWidget("initiatives", (_tui, theme) => ({
			render: (width: number) => {
				const prefix = `[init] ${focusedName}: ${partsSnapshot.join(" / ")}`;
				let line = prefix;
				if (todoTitle) {
					const prefixW = visibleWidth(prefix);
					// Budget: width - prefix - " > " separator (3 chars)
					const budget = width - prefixW - 4;
					if (budget > 10) {
						const truncTitle = truncateToWidth(todoTitle, budget);
						line = `${prefix} > ${truncTitle}`;
					}
				}
				return [truncateToWidth(theme.fg("accent", line), width)];
			},
			invalidate: () => {},
		}));
	} else {
		// Overview mode: show global summary
		const active = initiatives.filter((i) => isActive(i.status));
		const blocked = active.filter((i) => i.status === "blocked");
		const inProgress = active.filter((i) => i.status === "active");
		const allTodos = initiatives.flatMap((i) => i.todos);
		const openTodos = allTodos.filter((t) => t.state === "open");
		const wipTodos = allTodos.filter((t) => t.state === "wip");
		const staleTodos = wipTodos.filter((t) => isStaleWip(t));

		const parts: string[] = [];
		if (inProgress.length > 0) parts.push(`${inProgress.length} active`);
		if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
		const otherActive = active.length - inProgress.length - blocked.length;
		if (otherActive > 0) parts.push(`${otherActive} other`);
		if (openTodos.length > 0) parts.push(`${openTodos.length} todos`);
		if (wipTodos.length > 0) parts.push(`${wipTodos.length} wip`);
		if (staleTodos.length > 0) parts.push(`!! ${staleTodos.length} stale`);

		if (parts.length > 0) {
			const partsSnapshot = [...parts];
			ctx.ui.setWidget("initiatives", (_tui, theme) => ({
				render: (width: number) => {
					const line = `[init] ${partsSnapshot.join(" / ")}`;
					return [truncateToWidth(theme.fg("muted", line), width)];
				},
				invalidate: () => {},
			}));
		} else {
			ctx.ui.setWidget("initiatives", undefined);
		}
	}
}

// ─── List helpers ────────────────────────────────────────────────────────────

function buildSearchText(init: Initiative): string {
	return `${init.name} ${init.team} ${init.status} ${init.type} ${init.dri} ${init.stakeholders.join(" ")} ${init.tags.join(" ")}`.toLowerCase();
}

function filterInitiatives(initiatives: Initiative[], query: string): Initiative[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return initiatives;
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const matches: Array<{ init: Initiative; score: number }> = [];

	for (const init of initiatives) {
		const text = buildSearchText(init);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) { matched = false; break; }
			totalScore += result.score;
		}
		if (matched) matches.push({ init, score: totalScore });
	}
	return matches.sort((a, b) => a.score - b.score).map((m) => m.init);
}

interface ListItem {
	type: "header" | "initiative" | "new-action";
	team?: string;
	initiative?: Initiative;
}

function buildFlatList(initiatives: Initiative[]): ListItem[] {
	const groups = new Map<string, Initiative[]>();
	for (const init of initiatives) {
		const list = groups.get(init.team) ?? [];
		list.push(init);
		groups.set(init.team, list);
	}

	const items: ListItem[] = [];
	items.push({ type: "new-action" });
	for (const [team, inits] of groups) {
		items.push({ type: "header", team });
		const sorted = [...inits].sort((a, b) => {
			const aActive = isActive(a.status) ? 0 : 1;
			const bActive = isActive(b.status) ? 0 : 1;
			if (aActive !== bActive) return aActive - bActive;
			return a.name.localeCompare(b.name);
		});
		for (const init of sorted) {
			items.push({ type: "initiative", initiative: init });
		}
	}
	return items;
}

function getSelectableIndices(items: ListItem[]): number[] {
	return items.map((item, i) => (item.type === "initiative" || item.type === "new-action" ? i : -1)).filter((i) => i >= 0);
}

// ─── Text wrapping ───────────────────────────────────────────────────────────

function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length + word.length + 1 > width && current.length > 0) {
			lines.push(current);
			current = word;
		} else {
			current = current ? current + " " + word : word;
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

// ─── Split-Panel Todo List ───────────────────────────────────────────────────

/**
 * Build an ordered list of todos: WIP first, then open, then done.
 * Returns the flat list used for rendering and selection.
 */
function buildOrderedTodos(todos: Todo[]): Todo[] {
	const wip = todos.filter((t) => t.state === "wip");
	const open = todos.filter((t) => t.state === "open");
	const done = todos.filter((t) => t.state === "done");
	return [...wip, ...open, ...done];
}

/**
 * Renders a todo detail panel (right side of split view).
 */
function renderTodoDetailLines(
	todo: Todo,
	width: number,
	theme: Theme,
	options?: { maxBodyLines?: number; expanded?: boolean },
): string[] {
	const t = theme;
	const lines: string[] = [];

	// Title
	const stateIcon = todo.state === "wip" ? "◐" : todo.state === "done" ? "✓" : "○";
	const stateColor = todo.state === "wip" ? "accent" : todo.state === "done" ? "dim" : "warning";
	lines.push(truncateToWidth(t.fg("accent", t.bold(todo.title)), width));
	lines.push("");

	// Metadata
	lines.push(
		t.fg("muted", "State: ") +
		t.fg(stateColor, stateIcon + " " + todo.state) +
		(isStaleWip(todo) ? " " + t.fg("error", "⚠ stale") : "")
	);
	if (todo.id) {
		lines.push(t.fg("muted", "ID: ") + t.fg("dim", todo.id));
	}
	if (todo.assignee) {
		lines.push(t.fg("muted", "Assignee: ") + t.fg("text", "@" + todo.assignee));
	}
	if (todo.tag) {
		lines.push(t.fg("muted", "Tag: ") + t.fg("text", "#" + todo.tag));
	}
	if (todo.ts) {
		lines.push(t.fg("muted", "WIP since: ") + t.fg("dim", todo.ts));
	}
	if (todo.session) {
		lines.push(t.fg("muted", "Session: ") + t.fg("dim", todo.session));
	}

	// Body
	if (todo.body && todo.body.trim()) {
		lines.push("");
		lines.push(t.fg("accent", "Notes"));
		const bodyLines = todo.body.split("\n");
		const allWrapped: string[] = [];
		for (const bl of bodyLines) {
			const wrapped = wrapText(bl, width - 1);
			for (const wl of wrapped) {
				allWrapped.push(t.fg("text", wl));
			}
		}

		const maxBody = options?.maxBodyLines;
		const expanded = options?.expanded ?? false;

		if (maxBody && !expanded && allWrapped.length > maxBody) {
			lines.push(...allWrapped.slice(0, maxBody));
			const remaining = allWrapped.length - maxBody;
			lines.push("");
			lines.push(
				t.fg("dim", `▼ ${remaining} more lines — `) +
				t.fg("accent", "Tab") +
				t.fg("dim", " to expand"),
			);
		} else if (maxBody && expanded && allWrapped.length > maxBody) {
			lines.push(...allWrapped);
			lines.push("");
			lines.push(
				t.fg("dim", "▲ ") +
				t.fg("accent", "Tab") +
				t.fg("dim", " to collapse"),
			);
		} else {
			lines.push(...allWrapped);
		}
	} else {
		lines.push("");
		lines.push(t.fg("dim", "No notes yet."));
	}

	return lines;
}

/**
 * Creates a split-panel todo list component.
 * Left: selectable todo list. Right: detail/body of selected todo.
 */
function createTodoSplitPanel(
	initName: string,
	getTodos: () => Todo[],
	theme: Theme,
	tui: TUI,
	onSelect: (todo: Todo) => void,
	onCancel: () => void,
) {
	let selectedIndex = 0;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const expandedTodoIds = new Set<string>();

	const getOrdered = () => buildOrderedTodos(getTodos());

	const invalidate = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
	};

	const render = (width: number): string[] => {
		if (cachedLines && cachedWidth === width) return cachedLines;

		const t = theme;
		const ordered = getOrdered();
		const allTodos = getTodos();
		const lines: string[] = [];

		// Top border
		lines.push(t.fg("accent", "─".repeat(width)));
		lines.push("");

		// Header
		const wipCount = allTodos.filter((td) => td.state === "wip").length;
		const openCount = allTodos.filter((td) => td.state === "open").length;
		const doneCount = allTodos.filter((td) => td.state === "done").length;
		const countParts: string[] = [];
		if (wipCount > 0) countParts.push(`${wipCount} wip`);
		if (openCount > 0) countParts.push(`${openCount} open`);
		if (doneCount > 0) countParts.push(`${doneCount} done`);
		lines.push(truncateToWidth(
			t.fg("accent", t.bold(` Todos — ${initName}`)) + " " + t.fg("muted", countParts.join(", ")),
			width,
		));
		lines.push("");

		if (ordered.length === 0) {
			lines.push(t.fg("muted", "  No todos yet."));
			lines.push("");
			lines.push(t.fg("dim", " Esc back"));
			lines.push("");
			lines.push(t.fg("accent", "─".repeat(width)));
			cachedWidth = width;
			cachedLines = lines;
			return lines;
		}

		// Clamp selection
		selectedIndex = Math.min(selectedIndex, Math.max(0, ordered.length - 1));

		const hasSplit = width >= 70;
		const separatorStr = t.fg("borderMuted", " │ ");
		const separatorWidth = 3;
		const leftWidth = hasSplit ? Math.floor(width * 0.45) : width;
		const rightWidth = hasSplit ? width - leftWidth - separatorWidth : 0;

		// Compute stable viewport height
		const termHeight = process.stdout.rows || 24;
		const headerLines = lines.length; // already emitted above
		const footerLines = 4; // space + help text + space + border
		const contentHeight = Math.max(5, termHeight - headerLines - footerLines);

		// Build left lines (todo list) with scrolling viewport
		const allLeftLines: string[] = [];
		for (let i = 0; i < ordered.length; i++) {
			const todo = ordered[i];
			const isSelected = i === selectedIndex;
			const stateIcon = todo.state === "wip" ? "◐" : todo.state === "done" ? "✓" : "○";
			const stateColor = todo.state === "wip" ? "accent" : todo.state === "done" ? "dim" : "warning";
			const nameColor = isSelected ? "accent" : todo.state === "done" ? "dim" : "text";
			const prefix = isSelected ? t.fg("accent", "→ ") : "  ";

			const meta: string[] = [];
			if (todo.assignee) meta.push(t.fg("dim", `@${todo.assignee}`));
			if (todo.tag) meta.push(t.fg("dim", `#${todo.tag}`));
			if (isStaleWip(todo)) meta.push(t.fg("error", "⚠"));
			if (todo.body.trim()) meta.push(t.fg("dim", "📝"));
			const metaStr = meta.length > 0 ? " " + meta.join(" ") : "";

			allLeftLines.push(
				prefix +
				t.fg(stateColor, stateIcon) + " " +
				t.fg(nameColor, todo.title) +
				metaStr
			);
		}

		// Scroll left panel to keep selected item visible
		const scrollOffset = Math.max(0, Math.min(
			selectedIndex - Math.floor(contentHeight / 2),
			Math.max(0, allLeftLines.length - contentHeight),
		));
		const leftLines = allLeftLines.slice(scrollOffset, scrollOffset + contentHeight);

		// Add scroll indicators
		if (scrollOffset > 0) {
			leftLines[0] = t.fg("dim", `  ↑ ${scrollOffset} more`);
		}
		const belowCount = allLeftLines.length - scrollOffset - leftLines.length;
		if (belowCount > 0 && leftLines.length > 0) {
			leftLines[leftLines.length - 1] = t.fg("dim", `  ↓ ${belowCount} more`);
		}

		// Build right lines (detail panel), capped to contentHeight
		const rightLines: string[] = [];
		if (hasSplit && ordered.length > 0) {
			const selected = ordered[selectedIndex];
			if (selected) {
				const maxBodyLines = Math.max(5, Math.floor(contentHeight / 2) - 5);
				const isExpanded = expandedTodoIds.has(selected.id);
				const detail = renderTodoDetailLines(selected, rightWidth, theme, {
					maxBodyLines,
					expanded: isExpanded,
				});
				rightLines.push(...detail.slice(0, contentHeight));
			}
		}

		// Merge left + right with stable height
		for (let i = 0; i < contentHeight; i++) {
			const left = i < leftLines.length ? leftLines[i] : "";
			if (!hasSplit) {
				lines.push(truncateToWidth(left, width));
			} else {
				const right = i < rightLines.length ? rightLines[i] : "";
				const truncLeft = truncateToWidth(left, leftWidth);
				const leftPad = Math.max(0, leftWidth - visibleWidth(truncLeft));
				const truncRight = truncateToWidth(right, rightWidth);
				lines.push(truncLeft + " ".repeat(leftPad) + separatorStr + truncRight);
			}
		}

		lines.push("");
		lines.push(truncateToWidth(
			t.fg("dim", " ↑↓ select · Tab expand · Enter actions · Esc back"),
			width,
		));
		lines.push("");
		lines.push(t.fg("accent", "─".repeat(width)));

		cachedWidth = width;
		cachedLines = lines;
		return lines;
	};

	const handleInput = (keyData: string) => {
		const kb = getKeybindings();
		const ordered = getOrdered();

		if (kb.matches(keyData, "tui.select.up")) {
			if (ordered.length === 0) return;
			selectedIndex = selectedIndex === 0 ? ordered.length - 1 : selectedIndex - 1;
			invalidate();
			tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (ordered.length === 0) return;
			selectedIndex = selectedIndex === ordered.length - 1 ? 0 : selectedIndex + 1;
			invalidate();
			tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.tab)) {
			if (ordered.length === 0) return;
			const todo = ordered[selectedIndex];
			if (todo && todo.body.trim()) {
				if (expandedTodoIds.has(todo.id)) {
					expandedTodoIds.delete(todo.id);
				} else {
					expandedTodoIds.add(todo.id);
				}
				invalidate();
				tui.requestRender();
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			if (ordered.length === 0) return;
			const todo = ordered[selectedIndex];
			if (todo) {
				onSelect(todo);
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			onCancel();
			return;
		}
	};

	return { render, invalidate, handleInput };
}

// ─── TUI Component ──────────────────────────────────────────────────────────

class InitiativeSelectorComponent implements Focusable {
	private searchInput: Input;
	private allInitiatives: Initiative[];
	private filteredInitiatives: Initiative[];
	private flatList: ListItem[] = [];
	private selectableIndices: number[] = [];
	private selectedFlatIndex = 0;
	private selectedSelectablePos = 0;
	private onSelectCallback: (initiative: Initiative) => void;
	private onCancelCallback: () => void;
	private onNewCallback: (() => void) | null;
	private tui: TUI;
	private theme: Theme;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private _focused = false;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		initiatives: Initiative[],
		onSelect: (initiative: Initiative) => void,
		onCancel: () => void,
		initialSearch?: string,
		onNew?: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.allInitiatives = initiatives;
		this.filteredInitiatives = initiatives;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onNewCallback = onNew ?? null;

		this.searchInput = new Input();
		if (initialSearch) this.searchInput.setValue(initialSearch);
		this.searchInput.onSubmit = () => {
			if (this.handleNewActionIfSelected()) return;
			const selected = this.getSelectedInitiative();
			if (selected) this.onSelectCallback(selected);
		};

		this.applyFilter(this.searchInput.getValue());
	}

	getSearchValue(): string {
		return this.searchInput.getValue();
	}

	private handleNewActionIfSelected(): boolean {
		if (this.selectableIndices.length === 0) return false;
		const flatIdx = this.selectableIndices[this.selectedSelectablePos];
		const item = this.flatList[flatIdx];
		if (item?.type === "new-action" && this.onNewCallback) {
			this.onNewCallback();
			return true;
		}
		return false;
	}

	private getSelectedInitiative(): Initiative | null {
		if (this.selectableIndices.length === 0) return null;
		const flatIdx = this.selectableIndices[this.selectedSelectablePos];
		return this.flatList[flatIdx]?.initiative ?? null;
	}

	private applyFilter(query: string): void {
		this.filteredInitiatives = filterInitiatives(this.allInitiatives, query);
		this.flatList = buildFlatList(this.filteredInitiatives);
		this.selectableIndices = getSelectableIndices(this.flatList);
		this.selectedSelectablePos = Math.min(
			this.selectedSelectablePos,
			Math.max(0, this.selectableIndices.length - 1)
		);
		if (this.selectableIndices.length > 0) {
			this.selectedFlatIndex = this.selectableIndices[this.selectedSelectablePos];
		}
		this.invalidate();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.selectableIndices.length === 0) return;
			this.selectedSelectablePos =
				this.selectedSelectablePos === 0
					? this.selectableIndices.length - 1
					: this.selectedSelectablePos - 1;
			this.selectedFlatIndex = this.selectableIndices[this.selectedSelectablePos];
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.selectableIndices.length === 0) return;
			this.selectedSelectablePos =
				this.selectedSelectablePos === this.selectableIndices.length - 1
					? 0
					: this.selectedSelectablePos + 1;
			this.selectedFlatIndex = this.selectableIndices[this.selectedSelectablePos];
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			if (this.handleNewActionIfSelected()) return;
			const selected = this.getSelectedInitiative();
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		const prevValue = this.searchInput.getValue();
		this.searchInput.handleInput(keyData);
		const newValue = this.searchInput.getValue();
		// Only rebuild the list if the search text actually changed
		if (newValue !== prevValue) {
			this.applyFilter(newValue);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const t = this.theme;
		const lines: string[] = [];

		lines.push(t.fg("accent", "─".repeat(width)));
		lines.push("");

		const active = this.allInitiatives.filter((i) => isActive(i.status)).length;
		const complete = this.allInitiatives.length - active;
		const allTodos = this.allInitiatives.flatMap((i) => i.todos);
		const openTodos = allTodos.filter((td) => td.state === "open").length;
		const wipTodos = allTodos.filter((td) => td.state === "wip").length;
		const staleTodos = allTodos.filter((td) => isStaleWip(td)).length;
		const titleParts = [`${active} active`, `${complete} complete`];
		if (openTodos > 0) titleParts.push(`${openTodos} open todos`);
		if (wipTodos > 0) titleParts.push(`${wipTodos} wip`);
		const title = ` Initiatives (${titleParts.join(", ")})`;
		lines.push(truncateToWidth(t.fg("accent", t.bold(title)), width));

		// Stale WIP banner
		if (staleTodos > 0) {
			const staleByInit: Record<string, Todo[]> = {};
			for (const td of allTodos.filter((td) => isStaleWip(td))) {
				const key = td.initiative;
				if (!staleByInit[key]) staleByInit[key] = [];
				staleByInit[key].push(td);
			}
			lines.push(truncateToWidth(t.fg("error", ` ⚠️ ${staleTodos} stale WIP todo${staleTodos > 1 ? "s" : ""} (>24h):`), width));
			for (const [initName, todos] of Object.entries(staleByInit)) {
				for (const td of todos) {
					lines.push(truncateToWidth(t.fg("error", `   ${initName}: `) + t.fg("text", `"${td.title}"`) + t.fg("dim", ` (since ${td.ts})`), width));
				}
			}
		}

		lines.push("");

		const searchLines = this.searchInput.render(width);
		lines.push(...searchLines);
		lines.push("");

		const hasSplit = width >= 70;
		const separatorStr = t.fg("borderMuted", " │ ");
		const separatorWidth = 3;
		const leftWidth = hasSplit ? Math.floor(width * 0.50) : width;
		const rightWidth = hasSplit ? width - leftWidth - separatorWidth : 0;

		// Compute stable viewport height
		const termHeight = process.stdout.rows || 24;
		const headerLines = lines.length; // already emitted above
		const footerLines = 4; // space + help text + space + border
		const contentHeight = Math.max(5, termHeight - headerLines - footerLines);

		// Build ALL left lines (full list, before viewport slicing)
		const allLeftLines: string[] = [];
		let selectedLeftLine = 0; // track which left-line row the selected item starts on
		if (this.flatList.length === 0) {
			allLeftLines.push(t.fg("muted", "  No matching initiatives"));
		} else {
			for (let i = 0; i < this.flatList.length; i++) {
				const item = this.flatList[i];
				if (item.type === "new-action") {
					const isSelected = i === this.selectedFlatIndex;
					if (isSelected) selectedLeftLine = allLeftLines.length;
					const prefix = isSelected ? t.fg("accent", "→ ") : "  ";
					allLeftLines.push(prefix + t.fg("accent", "➕ New initiative"));
					allLeftLines.push("");
				} else if (item.type === "header") {
					allLeftLines.push(t.fg("muted", `  ─── ${item.team} ───`));
				} else if (item.initiative) {
					const init = item.initiative;
					const isSelected = i === this.selectedFlatIndex;
					if (isSelected) selectedLeftLine = allLeftLines.length;
					const icon = statusIcon(init.status);
					const color = statusColor(init.status);
					const prefix = isSelected ? t.fg("accent", "→ ") : "  ";
					const nameColor = isSelected ? "accent" : isActive(init.status) ? "text" : "dim";
					const sStatus = displayStatus(init.status);
					const tIcon = typeIcon(init.type);

					const openCount = init.todos.filter((td) => td.state === "open").length;
					const wipCount = init.todos.filter((td) => td.state === "wip").length;
					const staleCount = init.todos.filter((td) => isStaleWip(td)).length;
					const todoParts: string[] = [];
					if (openCount > 0) todoParts.push(t.fg("warning", `${openCount}`));
					if (wipCount > 0) todoParts.push(t.fg("accent", `${wipCount}◐`));
					if (staleCount > 0) todoParts.push(t.fg("error", `${staleCount}⚠`));
					const todoStr = todoParts.length > 0 ? " " + t.fg("dim", "[") + todoParts.join(t.fg("dim", "/")) + t.fg("dim", "]") : "";
					const prStr = init.prs.length > 0 ? t.fg("muted", ` PR:${init.prs.length}`) : "";

					const line =
						prefix +
						t.fg(color, icon) +
						" " +
						tIcon +
						" " +
						t.fg(nameColor, init.name) +
						todoStr +
						prStr +
						"  " +
						t.fg(color, sStatus);

					allLeftLines.push(line);
				}
			}
		}

		// Scroll left panel to keep selected item centered in viewport
		const scrollOffset = Math.max(0, Math.min(
			selectedLeftLine - Math.floor(contentHeight / 2),
			Math.max(0, allLeftLines.length - contentHeight),
		));
		const leftLines = allLeftLines.slice(scrollOffset, scrollOffset + contentHeight);

		// Add scroll indicators (replace first/last visible line)
		if (scrollOffset > 0 && leftLines.length > 0) {
			leftLines[0] = t.fg("dim", `  ↑ ${scrollOffset} more`);
		}
		const belowCount = allLeftLines.length - scrollOffset - leftLines.length;
		if (belowCount > 0 && leftLines.length > 1) {
			leftLines[leftLines.length - 1] = t.fg("dim", `  ↓ ${belowCount} more`);
		}

		// Build right lines (detail panel + todos), capped to contentHeight
		const allRightLines: string[] = [];
		if (hasSplit) {
			// Check if new-action is selected
			const selFlatIdx = this.selectableIndices.length > 0 ? this.selectableIndices[this.selectedSelectablePos] : -1;
			const selItem = selFlatIdx >= 0 ? this.flatList[selFlatIdx] : null;

			if (selItem?.type === "new-action") {
				allRightLines.push(t.fg("accent", t.bold("Create New Initiative")));
				allRightLines.push("");
				allRightLines.push(t.fg("text", "Start tracking a new initiative."));
				allRightLines.push(t.fg("text", "A wizard will guide you through:"));
				allRightLines.push("");
				allRightLines.push(t.fg("muted", "  • Team, name, and type"));
				allRightLines.push(t.fg("muted", "  • Priority and DRI"));
				allRightLines.push(t.fg("muted", "  • Stakeholders and description"));
				allRightLines.push(t.fg("muted", "  • Tags for search"));
				allRightLines.push("");
				allRightLines.push(t.fg("dim", "Press Enter to begin."));
			}

			const selected = this.getSelectedInitiative();
			if (selected) {
				allRightLines.push(t.fg("accent", t.bold(selected.name)));
				allRightLines.push(t.fg("muted", `${typeIcon(selected.type)} ${selected.type}`));
				allRightLines.push("");

				const summaryWrapped = wrapText(selected.summary, rightWidth - 1);
				for (const sl of summaryWrapped) {
					allRightLines.push(t.fg("text", sl));
				}
				allRightLines.push("");

				if (selected.dri && selected.dri !== selected.owner) {
					allRightLines.push(t.fg("muted", "DRI: ") + t.fg("text", selected.dri));
				}
				if (selected.stakeholders.length > 0) {
					allRightLines.push(t.fg("muted", "Stakeholders: ") + t.fg("text", selected.stakeholders.join(", ")));
				}
				if (selected.priority) {
					const pColor = selected.priority === "high" ? "error" : selected.priority === "medium" ? "warning" : "muted";
					allRightLines.push(t.fg("muted", "Priority: ") + t.fg(pColor, selected.priority));
				}
				const ss = displayStatus(selected.status);
				allRightLines.push(
					t.fg("muted", "Status: ") +
					t.fg(statusColor(selected.status), statusIcon(selected.status) + " " + ss)
				);
				if (selected.updated) {
					allRightLines.push(t.fg("muted", "Updated: ") + t.fg("dim", selected.updated));
				}

				// Todos section
				const openTds = selected.todos.filter((td) => td.state === "open");
				const wipTds = selected.todos.filter((td) => td.state === "wip");
				const doneTds = selected.todos.filter((td) => td.state === "done");
				if (selected.todos.length > 0) {
					const countParts = [];
					if (openTds.length > 0) countParts.push(`${openTds.length} open`);
					if (wipTds.length > 0) countParts.push(`${wipTds.length} wip`);
					if (doneTds.length > 0) countParts.push(`${doneTds.length} done`);
					allRightLines.push("");
					allRightLines.push(t.fg("accent", `Todos (${countParts.join(", ")})`));
					for (const td of wipTds) {
						const assignStr = td.assignee ? t.fg("dim", ` @${td.assignee}`) : "";
						const tagStr = td.tag ? t.fg("dim", ` #${td.tag}`) : "";
						const stale = isStaleWip(td);
						const icon = stale ? t.fg("error", "⚠") : t.fg("accent", "◐");
						const staleStr = stale ? t.fg("error", " stale") : "";
						allRightLines.push("  " + icon + " " + t.fg("text", td.title) + assignStr + tagStr + staleStr);
					}
					for (const td of openTds) {
						const assignStr = td.assignee ? t.fg("dim", ` @${td.assignee}`) : "";
						const tagStr = td.tag ? t.fg("dim", ` #${td.tag}`) : "";
						allRightLines.push("  " + t.fg("warning", "○") + " " + t.fg("text", td.title) + assignStr + tagStr);
					}
					// Show max 3 done todos
					const shownDone = doneTds.slice(0, 3);
					for (const td of shownDone) {
						allRightLines.push("  " + t.fg("dim", "✓ " + td.title));
					}
					if (doneTds.length > 3) {
						allRightLines.push(t.fg("dim", `  ... ${doneTds.length - 3} more done`));
					}
				}

				// PRs section
				if (selected.prs.length > 0) {
					allRightLines.push("");
					allRightLines.push(t.fg("accent", `Pull Requests (${selected.prs.length})`));
					for (const pr of selected.prs) {
						const statusLower = pr.status.toLowerCase();
						const prColor = statusLower.includes("merged") ? "success" : statusLower.includes("open") || statusLower.includes("draft") ? "warning" : "muted";
						allRightLines.push(
							"  " + t.fg(prColor, `#${pr.number}`) + " " +
							t.fg("text", truncateToWidth(pr.title, rightWidth - pr.number.length - 5)) +
							(pr.status ? " " + t.fg("dim", pr.status) : "")
						);
					}
				}
			}
		}

		// Cap right panel to contentHeight
		const rightLines = allRightLines.slice(0, contentHeight);

		// Merge left + right with stable height (always contentHeight rows)
		for (let i = 0; i < contentHeight; i++) {
			const left = i < leftLines.length ? leftLines[i] : "";
			if (!hasSplit) {
				lines.push(truncateToWidth(left, width));
			} else {
				const right = i < rightLines.length ? rightLines[i] : "";
				const truncLeft = truncateToWidth(left, leftWidth);
				const leftPad = Math.max(0, leftWidth - visibleWidth(truncLeft));
				const truncRight = truncateToWidth(right, rightWidth);
				lines.push(truncLeft + " ".repeat(leftPad) + separatorStr + truncRight);
			}
		}

		lines.push("");
		lines.push(
			truncateToWidth(
				t.fg("dim", " Type to search · ↑↓ select · Enter resume · Esc close"),
				width
			)
		);
		lines.push("");
		lines.push(t.fg("accent", "─".repeat(width)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Todo Tool Parameters ────────────────────────────────────────────────────

const TodoToolParams = Type.Object({
	action: StringEnum([
		"list",
		"list-all",
		"get",
		"add",
		"toggle",
		"start",
		"update",
		"append",
		"delete",
		"claim",
		"release",
		"complete-initiative",
		"set-status",
		"delete-initiative",
	] as const),
	initiative: Type.Optional(
		Type.String({ description: "Initiative name (folder name). Required for most actions." }),
	),
	id: Type.Optional(
		Type.String({ description: "Stable todo ID (8-char hex, e.g. a1b2c3d4). Preferred way to address a todo." }),
	),
	line: Type.Optional(
		Type.Number({ description: "0-based line index in todos.md. Fallback if id is not available." }),
	),
	title: Type.Optional(
		Type.String({ description: "Todo title text (for add, or new title for update)." }),
	),
	body: Type.Optional(
		Type.String({ description: "Markdown body/notes. For update: replaces body. For append: adds to existing body." }),
	),
	assignee: Type.Optional(
		Type.String({ description: "Person assigned to the todo (without @)." }),
	),
	tag: Type.Optional(
		Type.String({ description: "Tag for the todo (without #). E.g., next, blocked, waiting." }),
	),
	force: Type.Optional(
		Type.Boolean({ description: "Override another session's claim." }),
	),
	status: Type.Optional(
		Type.String({ description: "New initiative status for set-status action. Values: active, in-progress, paused, blocked, cancelled, complete." }),
	),
});

// ─── Extension ───────────────────────────────────────────────────────────────

export default function initiativesExtension(pi: ExtensionAPI) {
	let cachedInitiatives: Initiative[] = [];
	let activeInitiative: Initiative | null = null;
	let activeTodo: Todo | null = null;

	const refreshInitiatives = async (ctx: ExtensionContext) => {
		cachedInitiatives = await scanInitiatives();
		// If we have an active initiative, refresh its data from the new scan
		if (activeInitiative) {
			const updated = findInitiative(cachedInitiatives, activeInitiative.name);
			if (updated) activeInitiative = updated;
		}
		// Keep activeTodo in sync: clear if no longer WIP or deleted
		if (activeTodo && activeInitiative) {
			const freshTodo = activeInitiative.todos.find(t => t.id === activeTodo!.id);
			if (freshTodo && freshTodo.state === "wip") {
				activeTodo = freshTodo;
			} else {
				activeTodo = null;
			}
		} else if (activeTodo && !activeInitiative) {
			activeTodo = null;
		}
		updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);
	};

	pi.on("session_start", async (_event, ctx) => {
		await refreshInitiatives(ctx);
	});

	// ─── Todo Tool ───────────────────────────────────────────────────────

	// ─── Helper: resolve initiative or return error ─────────────────────
	const resolveInit = (name?: string) => {
		if (!name) return { error: "Error: initiative name required" };
		const init = findInitiative(cachedInitiatives, name);
		if (!init) {
			const names = cachedInitiatives.map((i) => i.name).join(", ");
			return { error: `Initiative "${name}" not found. Available: ${names}` };
		}
		return { init };
	};

	const errResult = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], details: { error: true } });

	const todoRef = (params: { id?: string; line?: number }) => {
		const label = params.id ? `id:${params.id}` : `line:${params.line}`;
		return label;
	};

	pi.registerTool({
		name: "initiative_todo",
		label: "Initiative Todo",
		description:
			`Manage todos for initiatives (${INITIATIVES_DIR}). ` +
			"Actions: list (todos for one initiative), list-all (all open/wip todos), " +
			"get (single todo with body), add (create todo), toggle (open↔done), " +
			"start (open→wip), update (change title/assignee/tag/body), " +
			"append (add to body without replacing), delete (remove), " +
			"claim (assign to session + wip), release (unassign + open), " +
			"complete-initiative (close initiative: set status=complete, optional closing comment via body), " +
			"set-status (change initiative status, requires status param), " +
			"delete-initiative (PERMANENTLY delete initiative: removes all files and folders from disk — cannot be undone). " +
			"Address todos by stable id (preferred) or line number (fallback). " +
			"States: [ ] open, [~] wip (in progress), [x] done. " +
			"Todos can have a markdown body (indented under the checkbox). " +
			"WIP todos have a timestamp (~ts:YYYY-MM-DDTHH:MM) and are flagged as stale after 24h.",
		parameters: TodoToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Refresh to get latest state (with auto-assigned IDs)
			cachedInitiatives = await scanInitiatives();

			const action = params.action;
			const sessionId = ctx.sessionManager.getSessionId();

			switch (action) {
				case "list": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					const init = res.init;
					// Ensure IDs are persisted
					const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
					const open = todos.filter((t) => t.state === "open");
					const wip = todos.filter((t) => t.state === "wip");
					const done = todos.filter((t) => t.state === "done");
					const result = {
						initiative: init.name,
						wip: wip.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, tag: t.tag, session: t.session, ts: t.ts, stale: isStaleWip(t), hasBody: !!t.body.trim() })),
						open: open.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, tag: t.tag, hasBody: !!t.body.trim() })),
						done: done.map((t) => ({ id: t.id, title: t.title })),
					};
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						details: { action: "list", initiative: init.name, openCount: open.length, wipCount: wip.length, doneCount: done.length },
					};
				}

				case "list-all": {
					// Ensure IDs for all initiatives
					for (const init of cachedInitiatives) {
						await readTodosWithIds(init.folderPath, init.name, init.team);
					}
					await refreshInitiatives(ctx);

					const allWip: Array<{ initiative: string; team: string; id: string; title: string; assignee: string; tag: string; session: string; ts: string; stale: boolean; hasBody: boolean }> = [];
					const allOpen: Array<{ initiative: string; team: string; id: string; title: string; assignee: string; tag: string; hasBody: boolean }> = [];
					for (const init of cachedInitiatives) {
						for (const t of init.todos) {
							if (t.state === "wip") {
								allWip.push({ initiative: init.name, team: init.team, id: t.id, title: t.title, assignee: t.assignee, tag: t.tag, session: t.session, ts: t.ts, stale: isStaleWip(t), hasBody: !!t.body.trim() });
							} else if (t.state === "open") {
								allOpen.push({ initiative: init.name, team: init.team, id: t.id, title: t.title, assignee: t.assignee, tag: t.tag, hasBody: !!t.body.trim() });
							}
						}
					}
					return {
						content: [{ type: "text", text: JSON.stringify({ wipTodos: allWip, openTodos: allOpen }, null, 2) }],
						details: { action: "list-all", wipCount: allWip.length, openCount: allOpen.length, staleCount: allWip.filter((t) => t.stale).length },
					};
				}

				case "get": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					const init = res.init;
					const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
					const todo = findTodo(todos, params.id, params.line);
					if (!todo) return errResult(`Todo ${todoRef(params)} not found in ${init.name}`);
					const result = { id: todo.id, title: todo.title, state: todo.state, assignee: todo.assignee, tag: todo.tag, body: todo.body, session: todo.session, ts: todo.ts, stale: isStaleWip(todo) };
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						details: { action: "get", initiative: init.name, id: todo.id },
					};
				}

				case "add": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.title) return errResult("Error: title required");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodos(init.folderPath, init.name, init.team);
						const newTodo: Todo = {
							id: generateTodoId(),
							line: -1,
							done: false,
							state: "open",
							title: params.title!,
							body: params.body ?? "",
							assignee: params.assignee ?? "",
							tag: params.tag ?? "",
							session: "",
							ts: "",
							raw: "",
							initiative: init.name,
							team: init.team,
						};
						todos.push(newTodo);
						await writeTodos(init.folderPath, todos);
						return newTodo;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Added todo to ${init.name}: "${params.title}" (id: ${lockResult.id})` }],
						details: { action: "add", initiative: init.name, id: lockResult.id },
					};
				}

				case "toggle": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.id && params.line === undefined) return errResult("Error: id or line required");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
						const idx = findTodoIndex(todos, params.id, params.line);
						if (idx === -1) return { error: `Todo ${todoRef(params)} not found in ${init.name}` };
						const todo = todos[idx];

						if (todo.state === "done") {
							todo.state = "open";
							todo.done = false;
							todo.session = "";
							todo.ts = "";
						} else {
							todo.state = "done";
							todo.done = true;
							todo.session = "";
							todo.ts = "";
						}
						await writeTodos(init.folderPath, todos);
						return todo;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					await refreshInitiatives(ctx);

					const verb = lockResult.state === "done" ? "Completed" : "Reopened";
					return {
						content: [{ type: "text", text: `${verb} todo in ${init.name}: "${lockResult.title}" (id: ${lockResult.id})` }],
						details: { action: "toggle", initiative: init.name, id: lockResult.id, state: lockResult.state },
					};
				}

				case "start": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.id && params.line === undefined) return errResult("Error: id or line required");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
						const idx = findTodoIndex(todos, params.id, params.line);
						if (idx === -1) return { error: `Todo ${todoRef(params)} not found in ${init.name}` };
						const todo = todos[idx];

						if (todo.state === "done") return { error: "Cannot start a completed todo — reopen it first" };
						if (todo.state === "wip") return { error: `Todo is already WIP (since ${todo.ts})` };

						todo.state = "wip";
						todo.done = false;
						todo.ts = nowTimestamp();
						if (params.assignee) todo.assignee = params.assignee;
						await writeTodos(init.folderPath, todos);
						return todo;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Started todo in ${init.name}: "${lockResult.title}" (id: ${lockResult.id}, wip since ${lockResult.ts})` }],
						details: { action: "start", initiative: init.name, id: lockResult.id, ts: lockResult.ts },
					};
				}

				case "update": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.id && params.line === undefined) return errResult("Error: id or line required");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
						const idx = findTodoIndex(todos, params.id, params.line);
						if (idx === -1) return { error: `Todo ${todoRef(params)} not found in ${init.name}` };
						const todo = todos[idx];

						if (params.title !== undefined) todo.title = params.title;
						if (params.assignee !== undefined) todo.assignee = params.assignee;
						if (params.tag !== undefined) todo.tag = params.tag;
						if (params.body !== undefined) todo.body = params.body;

						await writeTodos(init.folderPath, todos);
						return todo;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Updated todo in ${init.name}: "${lockResult.title}" (id: ${lockResult.id})` }],
						details: { action: "update", initiative: init.name, id: lockResult.id },
					};
				}

				case "append": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.id && params.line === undefined) return errResult("Error: id or line required");
					if (!params.body || !params.body.trim()) return errResult("Error: body text required for append");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
						const idx = findTodoIndex(todos, params.id, params.line);
						if (idx === -1) return { error: `Todo ${todoRef(params)} not found in ${init.name}` };
						const todo = todos[idx];

						const spacer = todo.body.trim().length ? "\n\n" : "";
						todo.body = todo.body.replace(/\s+$/, "") + spacer + params.body!.trim();

						await writeTodos(init.folderPath, todos);
						return todo;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Appended to todo in ${init.name}: "${lockResult.title}" (id: ${lockResult.id})` }],
						details: { action: "append", initiative: init.name, id: lockResult.id },
					};
				}

				case "delete": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.id && params.line === undefined) return errResult("Error: id or line required");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
						const idx = findTodoIndex(todos, params.id, params.line);
						if (idx === -1) return { error: `Todo ${todoRef(params)} not found in ${init.name}` };
						const removed = todos.splice(idx, 1)[0];
						await writeTodos(init.folderPath, todos);
						return removed;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Deleted todo from ${init.name}: "${lockResult.title}" (id: ${lockResult.id})` }],
						details: { action: "delete", initiative: init.name, id: lockResult.id },
					};
				}

				case "claim": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.id && params.line === undefined) return errResult("Error: id or line required");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
						const idx = findTodoIndex(todos, params.id, params.line);
						if (idx === -1) return { error: `Todo ${todoRef(params)} not found in ${init.name}` };
						const todo = todos[idx];

						if (todo.state === "done") return { error: "Todo is already done" };
						if (todo.session && todo.session !== sessionId && !params.force) {
							return { error: `Todo is claimed by session ${todo.session}. Use force=true to override.` };
						}

						todo.state = "wip";
						todo.done = false;
						todo.session = sessionId;
						todo.ts = todo.ts || nowTimestamp();
						await writeTodos(init.folderPath, todos);
						return todo;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					// Set active todo + initiative for widget display
					activeTodo = lockResult as Todo;
					if (!activeInitiative) {
						activeInitiative = init;
					}
					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Claimed todo in ${init.name}: "${lockResult.title}" (id: ${lockResult.id}, session: ${sessionId})` }],
						details: { action: "claim", initiative: init.name, id: lockResult.id, session: sessionId, ts: lockResult.ts },
					};
				}

				case "release": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.id && params.line === undefined) return errResult("Error: id or line required");
					const init = res.init;

					const lockResult = await withTodoLock(init.folderPath, sessionId, async () => {
						const todos = await readTodosWithIds(init.folderPath, init.name, init.team);
						const idx = findTodoIndex(todos, params.id, params.line);
						if (idx === -1) return { error: `Todo ${todoRef(params)} not found in ${init.name}` };
						const todo = todos[idx];

						if (todo.session && todo.session !== sessionId && !params.force) {
							return { error: `Todo is claimed by session ${todo.session}. Use force=true to override.` };
						}

						todo.state = "open";
						todo.done = false;
						todo.session = "";
						todo.ts = "";
						await writeTodos(init.folderPath, todos);
						return todo;
					});

					if (typeof lockResult === "object" && "error" in lockResult) return errResult(lockResult.error);
					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Released todo in ${init.name}: "${lockResult.title}" (id: ${lockResult.id}, reverted to open)` }],
						details: { action: "release", initiative: init.name, id: lockResult.id },
					};
				}

				case "complete-initiative": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					const init = res.init;
					const indexPath = path.join(init.folderPath, "index.md");

					await updateFrontmatterFields(indexPath, {
						status: "complete",
						updated: todayDate(),
					});
					await appendClosingNotes(indexPath, params.body);
					await refreshInitiatives(ctx);

					const comment = params.body?.trim() ? ` Comment: "${params.body.trim()}"` : "";
					return {
						content: [{ type: "text", text: `Completed initiative "${init.name}".${comment}` }],
						details: { action: "complete-initiative", initiative: init.name, status: "complete" },
					};
				}

				case "set-status": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					if (!params.status) return errResult("Error: status parameter required. Values: active, in-progress, paused, blocked, cancelled, complete.");
					const newStatus = params.status.toLowerCase();
					if (!VALID_STATUSES.includes(newStatus as InitiativeStatus)) {
						return errResult(`Invalid status "${params.status}". Valid values: ${VALID_STATUSES.join(", ")}`);
					}
					const init = res.init;
					const indexPath = path.join(init.folderPath, "index.md");

					const updates: Record<string, string> = {
						status: newStatus,
						updated: todayDate(),
					};
					await updateFrontmatterFields(indexPath, updates);

					// If completing via set-status, also append closing notes
					if (newStatus === "complete") {
						await appendClosingNotes(indexPath, params.body);
					}

					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Updated initiative "${init.name}" status: ${init.status} → ${newStatus}` }],
						details: { action: "set-status", initiative: init.name, status: newStatus, previousStatus: init.status },
					};
				}

				case "delete-initiative": {
					const res = resolveInit(params.initiative);
					if ("error" in res) return errResult(res.error);
					const init = res.init;

					// Confirm with the user via UI if available
					if (ctx.hasUI) {
						const confirmed = await ctx.ui.confirm(
							"⚠️ Delete Initiative",
							`Are you sure you want to permanently delete "${init.name}"?\n\n` +
							`This will remove the entire folder and ALL files:\n${init.folderPath}\n\n` +
							`This action cannot be undone.`,
						);
						if (!confirmed) {
							return {
								content: [{ type: "text", text: `Deletion of "${init.name}" cancelled by user.` }],
								details: { action: "delete-initiative", initiative: init.name, cancelled: true },
							};
						}
					}

					// Remove the entire initiative folder
					await fs.rm(init.folderPath, { recursive: true, force: true });

					// Clear active state if this was the active initiative
					if (activeInitiative?.name === init.name) {
						activeInitiative = null;
						activeTodo = null;
					}

					await refreshInitiatives(ctx);

					return {
						content: [{ type: "text", text: `Permanently deleted initiative "${init.name}" and all its files from ${init.folderPath}` }],
						details: { action: "delete-initiative", initiative: init.name, folderPath: init.folderPath },
					};
				}
			}
		},

		renderCall(args, theme) {
			const action = typeof args.action === "string" ? args.action : "";
			const initiative = typeof args.initiative === "string" ? args.initiative : "";
			const todoId = typeof args.id === "string" ? args.id : "";
			const title = typeof args.title === "string" ? args.title : "";
			let text = theme.fg("toolTitle", theme.bold("initiative_todo ")) + theme.fg("muted", action);
			if (initiative) text += " " + theme.fg("accent", initiative);
			if (todoId) text += " " + theme.fg("dim", `~id:${todoId}`);
			if (title) text += " " + theme.fg("dim", `"${title}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Processing..."), 0, 0);

			const details = result.details as Record<string, any> | undefined;
			if (details?.error) {
				const text = result.content[0];
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
			}

			const action = details?.action;

			if (action === "list") {
				const parts = [];
				if (details?.wipCount > 0) parts.push(`${details.wipCount} wip`);
				parts.push(`${details?.openCount ?? 0} open`);
				if (details?.doneCount > 0) parts.push(`${details.doneCount} done`);
				let text = theme.fg("success", "✓ ") + theme.fg("muted", parts.join(", ")) + theme.fg("dim", ` in ${details?.initiative}`);
				if (expanded) {
					const raw = result.content[0];
					if (raw?.type === "text") text += "\n" + theme.fg("dim", raw.text);
				}
				return new Text(text, 0, 0);
			}

			if (action === "list-all") {
				const parts = [];
				if (details?.wipCount > 0) parts.push(`${details.wipCount} wip`);
				parts.push(`${details?.openCount ?? 0} open`);
				if (details?.staleCount > 0) parts.push(theme.fg("error", `${details.staleCount} stale`));
				let text = theme.fg("success", "✓ ") + theme.fg("muted", parts.join(", "));
				if (expanded) {
					const raw = result.content[0];
					if (raw?.type === "text") text += "\n" + theme.fg("dim", raw.text);
				}
				return new Text(text, 0, 0);
			}

			if (action === "get") {
				let text = theme.fg("success", "✓ ") + theme.fg("muted", `Todo ${details?.id} in `) + theme.fg("accent", details?.initiative);
				if (expanded) {
					const raw = result.content[0];
					if (raw?.type === "text") text += "\n" + theme.fg("dim", raw.text);
				}
				return new Text(text, 0, 0);
			}

			if (action === "add") {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "Added ") + theme.fg("dim", details?.id ?? "") + theme.fg("muted", " to ") + theme.fg("accent", details?.initiative),
					0, 0,
				);
			}

			if (action === "toggle") {
				const verb = details?.state === "done" ? "Completed" : "Reopened";
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", `${verb} `) + theme.fg("dim", details?.id ?? "") + theme.fg("muted", " in ") + theme.fg("accent", details?.initiative),
					0, 0,
				);
			}

			if (action === "start") {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "Started WIP ") + theme.fg("dim", details?.id ?? "") + theme.fg("muted", " in ") + theme.fg("accent", details?.initiative) + theme.fg("dim", ` (${details?.ts})`),
					0, 0,
				);
			}

			if (action === "append") {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "Appended to ") + theme.fg("dim", details?.id ?? "") + theme.fg("muted", " in ") + theme.fg("accent", details?.initiative),
					0, 0,
				);
			}

			if (action === "claim" || action === "release") {
				const verb = action === "claim" ? "Claimed" : "Released";
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", `${verb} `) + theme.fg("dim", details?.id ?? "") + theme.fg("muted", " in ") + theme.fg("accent", details?.initiative),
					0, 0,
				);
			}

			if (action === "delete") {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "Deleted ") + theme.fg("dim", details?.id ?? "") + theme.fg("muted", " from ") + theme.fg("accent", details?.initiative),
					0, 0,
				);
			}

			if (action === "complete-initiative") {
				return new Text(
					theme.fg("success", "✅ ") + theme.fg("muted", "Completed ") + theme.fg("accent", details?.initiative),
					0, 0,
				);
			}

			if (action === "set-status") {
				const icon = statusIcon(details?.status ?? "");
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "Status → ") + theme.fg("accent", `${icon} ${details?.status}`) + theme.fg("muted", " in ") + theme.fg("accent", details?.initiative),
					0, 0,
				);
			}

			if (action === "delete-initiative") {
				if (details?.cancelled) {
					return new Text(
						theme.fg("warning", "⚠ ") + theme.fg("muted", "Deletion cancelled for ") + theme.fg("accent", details?.initiative),
						0, 0,
					);
				}
				return new Text(
					theme.fg("error", "🗑️ ") + theme.fg("muted", "Deleted ") + theme.fg("accent", details?.initiative ?? "") + theme.fg("dim", ` (${details?.folderPath})`),
					0, 0,
				);
			}

			// Fallback
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// ─── /initiatives Command ────────────────────────────────────────────

	pi.registerCommand("initiatives", {
		description: "Browse and resume initiatives",
		handler: async (args, ctx) => {
			await refreshInitiatives(ctx);

			if (cachedInitiatives.length === 0) {
				ctx.ui.notify("No initiatives found in " + INITIATIVES_DIR, "warning");
				return;
			}

			if (!ctx.hasUI) {
				for (const init of cachedInitiatives) {
					const icon = statusIcon(init.status);
					const openTodos = init.todos.filter((t) => t.state === "open").length;
					const wipTodos = init.todos.filter((t) => t.state === "wip").length;
					const parts: string[] = [];
					if (openTodos > 0) parts.push(`${openTodos} open`);
					if (wipTodos > 0) parts.push(`${wipTodos} wip`);
					const todoStr = parts.length > 0 ? ` [${parts.join(", ")}]` : "";
					console.log(`${icon} [${init.team}] ${init.name} — ${init.status}${todoStr}`);
				}
				return;
			}

			const searchTerm = (args ?? "").trim();
			let nextPrompt: string | null = null;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				// ── State machine: which component is active ──
				let activeComponent: {
					render: (width: number) => string[];
					invalidate: () => void;
					handleInput?: (data: string) => void;
					focused?: boolean;
				} | null = null;
				let wrapperFocused = false;

				const setActive = (comp: typeof activeComponent) => {
					if (activeComponent && "focused" in activeComponent) activeComponent.focused = false;
					activeComponent = comp;
					if (activeComponent && "focused" in activeComponent) activeComponent.focused = wrapperFocused;
					tui.requestRender();
				};

				// ── Helper: build action menu for an initiative ──
				const showActionMenu = (init: Initiative) => {
					const openCount = init.todos.filter((t) => t.state === "open").length;
					const wipCount = init.todos.filter((t) => t.state === "wip").length;
					const staleCount = init.todos.filter((t) => isStaleWip(t)).length;
					const todoParts: string[] = [];
					if (wipCount > 0) todoParts.push(`${wipCount} wip`);
					if (openCount > 0) todoParts.push(`${openCount} open`);
					if (staleCount > 0) todoParts.push(`${staleCount} stale`);
					const todosLabel = todoParts.length > 0 ? `todos (${todoParts.join(", ")})` : "todos";
					const prsLabel = init.prs.length > 0 ? `pull requests (${init.prs.length})` : "pull requests";

					const items: SelectItem[] = [
						{ value: "resume-quick", label: "resume quick (recommended)", description: "Read index.md + active todos first" },
						{ value: "resume-full", label: "resume everything", description: "Read all markdown files in the initiative" },
						{ value: "todos", label: todosLabel, description: "View & manage todos" },
						{ value: "add-todo", label: "add todo", description: "Add a new todo" },
						{ value: "prs", label: prsLabel, description: "View pull requests & copy links" },
						{ value: "copy-path", label: "copy path", description: "Copy folder path to clipboard" },
					];

					// Status actions — complete is prominent, change status for other transitions
					if (init.status !== "complete") {
						items.push({ value: "complete", label: "✅ complete", description: "Close this initiative as done" });
					}
					items.push({ value: "change-status", label: "🔄 change status", description: `Current: ${displayStatus(init.status)}` });
					items.push({ value: "delete-initiative", label: "🗑️ delete initiative", description: "Permanently remove all files" });

					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						theme.fg("accent", theme.bold(` Actions for "${init.name}"`)),
						1, 0,
					));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						theme.fg("muted", "  Note: quick resume is recommended — it loads index.md + active todos first."),
						1, 0,
					));
					container.addChild(new Text(
						theme.fg("muted", "  Resume everything reads all markdown files, including history/archive."),
						1, 0,
					));
					container.addChild(new Spacer(1));

					const selectList = new SelectList(items, items.length, {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					selectList.onSelect = (item) => {
						switch (item.value) {
							case "resume-quick": {
								activeInitiative = init;
								updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);
								nextPrompt = buildQuickResumePrompt(init);
								done();
								break;
							}
							case "resume-full": {
								activeInitiative = init;
								updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);
								nextPrompt = buildFullResumePrompt(init);
								done();
								break;
							}
							case "todos": {
								showTodosList(init);
								break;
							}
							case "add-todo": {
								showAddTodo(init);
								break;
							}
							case "prs": {
								showPRsList(init);
								break;
							}
							case "copy-path": {
								try {
									copyToClipboard(init.folderPath);
									ctx.ui.notify(`Copied: ${init.folderPath}`, "info");
								} catch (e) {
									ctx.ui.notify(`Failed to copy: ${e}`, "error");
								}
								// Stay on action menu
								break;
							}
							case "complete": {
								showCompleteInit(init);
								break;
							}
							case "change-status": {
								showChangeStatus(init);
								break;
							}
							case "delete-initiative": {
								showDeleteInit(init);
								break;
							}
						}
					};
					selectList.onCancel = () => {
						showInitiativeSelector();
					};

					container.addChild(selectList);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " Enter to confirm · Esc back"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					setActive({
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
					});
				};

				// ── Helper: refresh todos after mutation ──
				const refreshTodos = async (init: Initiative) => {
					init.todos = await readTodos(init.folderPath, init.name, init.team);
					cachedInitiatives = cachedInitiatives.map((i) =>
						i.name === init.name && i.team === init.team ? { ...i, todos: init.todos } : i
					);
					// Sync activeTodo: clear if no longer WIP or deleted
					if (activeTodo) {
						const fresh = init.todos.find(t => t.id === activeTodo!.id);
						if (fresh && fresh.state === "wip") activeTodo = fresh;
						else activeTodo = null;
					}
					updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);
				};

				// ── Helper: show todo action menu for a single todo ──
				const showTodoActionMenu = (init: Initiative, todo: Todo) => {
					const items: SelectItem[] = [];

					if (todo.state === "done") {
						items.push({ value: "reopen", label: "🔄 Reopen", description: "Mark as open again" });
					} else {
						items.push({
							value: "assign",
							label: "🤖 Assign to agent",
							description: "Claim, lock to this session, and start working",
						});
						items.push({
							value: "complete",
							label: "✅ Mark as completed",
							description: "For tasks done outside the agent",
						});
					}

					// Delete is always available regardless of state
					items.push({
						value: "delete",
						label: "🗑️ Delete",
						description: "Remove this todo permanently",
					});

					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));

					const stateIcon = todo.state === "wip" ? "◐" : todo.state === "done" ? "✓" : "○";
					container.addChild(new Text(
						theme.fg("accent", theme.bold(` ${stateIcon} ${todo.title}`)),
						1, 0,
					));
					if (todo.assignee || todo.tag) {
						const meta: string[] = [];
						if (todo.assignee) meta.push(`@${todo.assignee}`);
						if (todo.tag) meta.push(`#${todo.tag}`);
						container.addChild(new Text(theme.fg("muted", `   ${meta.join("  ")}`), 1, 0));
					}
					container.addChild(new Spacer(1));

					const selectList = new SelectList(items, items.length, {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					selectList.onSelect = async (item) => {
						switch (item.value) {
							case "assign": {
								// Claim: mark WIP, assign session, lock
								const sessionId = ctx.sessionManager.getSessionId();
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const found = todos.find(t => t.id === todo.id);
								if (!found) {
									ctx.ui.notify("Todo not found", "error");
									showTodosList(init);
									return;
								}
								found.state = "wip";
								found.done = false;
								found.session = sessionId;
								found.ts = found.ts || nowTimestamp();
								await writeTodos(init.folderPath, todos);
								await refreshTodos(init);

								// Set active initiative + todo and exit TUI
								activeTodo = found;
								activeInitiative = init;
								updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);

								const bodyHint = todo.body.trim()
									? ` The todo has a body with details — read it from ${init.folderPath}/todos.md.`
									: "";
								nextPrompt = `I've assigned you todo "${todo.title}" (id: ${todo.id}) from the "${init.name}" initiative. ` +
									`It's now marked as WIP and locked to this session.${bodyHint} ` +
									`Start working on it. When done, mark it complete with initiative_todo toggle.`;
								done();
								break;
							}
							case "complete": {
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const found = todos.find(t => t.id === todo.id);
								if (!found) {
									ctx.ui.notify("Todo not found", "error");
									showTodosList(init);
									return;
								}
								found.state = "done";
								found.done = true;
								found.session = "";
								found.ts = "";
								await writeTodos(init.folderPath, todos);
								await refreshTodos(init);
								ctx.ui.notify(`Completed: ${todo.title}`, "info");
								showTodosList(init);
								break;
							}
							case "reopen": {
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const found = todos.find(t => t.id === todo.id);
								if (!found) {
									ctx.ui.notify("Todo not found", "error");
									showTodosList(init);
									return;
								}
								found.state = "open";
								found.done = false;
								found.session = "";
								found.ts = "";
								await writeTodos(init.folderPath, todos);
								await refreshTodos(init);
								ctx.ui.notify(`Reopened: ${todo.title}`, "info");
								showTodosList(init);
								break;
							}
							case "delete": {
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const idx = todos.findIndex(t => t.id === todo.id);
								if (idx === -1) {
									ctx.ui.notify("Todo not found", "error");
									showTodosList(init);
									return;
								}
								todos.splice(idx, 1);
								await writeTodos(init.folderPath, todos);
								await refreshTodos(init);
								ctx.ui.notify(`Deleted: ${todo.title}`, "info");
								showTodosList(init);
								break;
							}
						}
					};

					selectList.onCancel = () => {
						showTodosList(init);
					};

					container.addChild(selectList);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " Enter select · Esc back"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					setActive({
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
					});
				};

				// ── Helper: show todos list for an initiative ──
				const showTodosList = (init: Initiative) => {
					const panel = createTodoSplitPanel(
						init.name,
						() => init.todos,
						theme,
						tui,
						(todo) => showTodoActionMenu(init, todo),
						() => showActionMenu(init),
					);

					setActive({
						render: (w) => panel.render(w),
						invalidate: () => panel.invalidate(),
						handleInput: (data) => panel.handleInput(data),
					});
				};

				// ── Helper: add todo input ──
				const showAddTodo = (init: Initiative) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						theme.fg("accent", theme.bold(` Add todo to "${init.name}"`)),
						1, 0,
					));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", " Title (use @name for assignee, #tag for tag):"), 1, 0));

					const input = new Input();
					container.addChild(input);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " Enter to add · Esc cancel"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					input.onSubmit = async () => {
						const text = input.getValue().trim();
						if (!text) {
							showActionMenu(init);
							return;
						}

						// Parse inline @assignee and #tag from the title
						let title = text;
						let assignee = "";
						let tag = "";
						const assigneeMatch = title.match(/@(\w+)/);
						if (assigneeMatch) {
							assignee = assigneeMatch[1];
							title = title.replace(/\s*@\w+/, "").trim();
						}
						const tagMatch = title.match(/#(\w[\w-]*)/);
						if (tagMatch) {
							tag = tagMatch[1];
							title = title.replace(/\s*#\w[\w-]*/, "").trim();
						}

						// Add via structured read/write to preserve bodies and IDs
						const todos = await readTodos(init.folderPath, init.name, init.team);
						const newTodo: Todo = {
							id: generateTodoId(),
							line: -1,
							done: false,
							state: "open",
							title,
							body: "",
							assignee,
							tag,
							session: "",
							ts: "",
							raw: "",
							initiative: init.name,
							team: init.team,
						};
						todos.push(newTodo);
						await writeTodos(init.folderPath, todos);

						// Refresh
						init.todos = await readTodos(init.folderPath, init.name, init.team);
						cachedInitiatives = cachedInitiatives.map((i) =>
							i.name === init.name && i.team === init.team ? { ...i, todos: init.todos } : i
						);
						updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);

						ctx.ui.notify(`Added: ${title}`, "info");
						showActionMenu(init);
					};

					setActive({
						get focused() { return input.focused; },
						set focused(v: boolean) { input.focused = v; },
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							const kb = getKeybindings();
							if (kb.matches(data, "tui.select.cancel")) {
								showActionMenu(init);
								return;
							}
							input.handleInput(data);
							tui.requestRender();
						},
					});
				};

				// ── Helper: show pull requests list ──
				const showPRsList = (init: Initiative) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						theme.fg("accent", theme.bold(` Pull Requests for "${init.name}" (${init.prs.length})`)),
						1, 0,
					));
					container.addChild(new Spacer(1));

					if (init.prs.length === 0) {
						container.addChild(new Text(theme.fg("muted", "  No pull requests linked yet."), 0, 0));
						container.addChild(new Text(theme.fg("muted", "  Add them to index.md under ## Pull Requests"), 0, 0));
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", " Esc back"), 1, 0));
						container.addChild(new Spacer(1));
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						setActive({
							render: (w) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data) => {
								const kb = getKeybindings();
								if (kb.matches(data, "tui.select.cancel")) showActionMenu(init);
							},
						});
						return;
					}

					const items: SelectItem[] = init.prs.map((pr) => {
						const statusLower = pr.status.toLowerCase();
						const statusStr = pr.status ? ` — ${pr.status}` : "";
						const repoStr = pr.repo ? ` (${pr.repo})` : "";
						return {
							value: pr.url,
							label: `#${pr.number} ${pr.title}`,
							description: `${statusStr}${repoStr}`,
						};
					});

					const selectList = new SelectList(items, Math.min(items.length, 15), {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					selectList.onSelect = (item) => {
						try {
							copyToClipboard(item.value);
							ctx.ui.notify(`Copied: ${item.value}`, "info");
						} catch (e) {
							ctx.ui.notify(`Failed to copy: ${e}`, "error");
						}
					};
					selectList.onCancel = () => {
						showActionMenu(init);
					};

					container.addChild(selectList);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " Enter to copy link · Esc back"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					setActive({
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
					});
				};

				// ── Helper: complete initiative with optional comment ──
				const showCompleteInit = (init: Initiative) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						theme.fg("accent", theme.bold(` ✅ Complete "${init.name}"`)),
						1, 0,
					));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", " Closing comment (optional, Enter to confirm):"), 1, 0));

					const input = new Input();
					container.addChild(input);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " Enter to complete · Esc cancel"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					input.onSubmit = async () => {
						const comment = input.getValue().trim() || undefined;
						const indexPath = path.join(init.folderPath, "index.md");

						await updateFrontmatterFields(indexPath, {
							status: "complete",
							updated: todayDate(),
						});
						await appendClosingNotes(indexPath, comment);
						await refreshInitiatives(ctx);

						ctx.ui.notify(`✅ Completed: ${init.name}`, "info");

						// If this was the active initiative, clear it
						if (activeInitiative?.name === init.name) {
							activeInitiative = null;
							activeTodo = null;
						}
						updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);
						showInitiativeSelector();
					};

					setActive({
						get focused() { return input.focused; },
						set focused(v: boolean) { input.focused = v; },
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							const kb = getKeybindings();
							if (kb.matches(data, "tui.select.cancel")) {
								showActionMenu(init);
								return;
							}
							input.handleInput(data);
							tui.requestRender();
						},
					});
				};

				// ── Helper: change initiative status ──
				const showChangeStatus = (init: Initiative) => {
					const statuses: Array<{ value: string; label: string; icon: string; description: string }> = [
						{ value: "active", label: "● Active", icon: "●", description: "Actively being worked on" },
						{ value: "in-progress", label: "● In Progress", icon: "●", description: "Work underway" },
						{ value: "paused", label: "◐ Paused", icon: "◐", description: "Temporarily on hold" },
						{ value: "blocked", label: "⏸ Blocked", icon: "⏸", description: "Waiting on dependency or decision" },
						{ value: "cancelled", label: "⛔ Cancelled", icon: "⛔", description: "No longer pursuing" },
						{ value: "complete", label: "✓ Complete", icon: "✓", description: "Done — will prompt for closing comment" },
					];

					const items: SelectItem[] = statuses
						.filter((s) => s.value !== init.status)
						.map((s) => ({
							value: s.value,
							label: s.label,
							description: s.description,
						}));

					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						theme.fg("accent", theme.bold(` Change status for "${init.name}"`)),
						1, 0,
					));
					container.addChild(new Text(
						theme.fg("muted", `   Current: ${statusIcon(init.status)} ${displayStatus(init.status)}`),
						1, 0,
					));
					container.addChild(new Spacer(1));

					const selectList = new SelectList(items, items.length, {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					selectList.onSelect = async (item) => {
						if (item.value === "complete") {
							// Route to the complete flow for closing comment
							showCompleteInit(init);
							return;
						}

						const indexPath = path.join(init.folderPath, "index.md");
						await updateFrontmatterFields(indexPath, {
							status: item.value,
							updated: todayDate(),
						});
						await refreshInitiatives(ctx);

						const icon = statusIcon(item.value);
						ctx.ui.notify(`${icon} ${init.name} → ${displayStatus(item.value)}`, "info");
						updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);
						showActionMenu(init);
					};

					selectList.onCancel = () => {
						showActionMenu(init);
					};

					container.addChild(selectList);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " Enter select · Esc back"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					setActive({
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
					});
				};

				// ── Helper: delete initiative with confirmation ──
				const showDeleteInit = (init: Initiative) => {
					const t = theme;
					const todoCount = init.todos.length;
					const prCount = init.prs.length;

					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => t.fg("error", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("error", t.bold(" ⚠️  Delete Initiative")), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						t.fg("text", " You are about to ") +
						t.fg("error", t.bold("permanently delete")) +
						t.fg("text", " the initiative:"),
						1, 0,
					));
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("accent", t.bold(`   ${init.name}`)), 1, 0));
					container.addChild(new Text(t.fg("muted", `   Team: ${init.team} · Status: ${displayStatus(init.status)}`), 1, 0));
					if (todoCount > 0 || prCount > 0) {
						const parts: string[] = [];
						if (todoCount > 0) parts.push(`${todoCount} todo${todoCount > 1 ? "s" : ""}`);
						if (prCount > 0) parts.push(`${prCount} PR${prCount > 1 ? "s" : ""}`);
						container.addChild(new Text(t.fg("muted", `   Contains: ${parts.join(", ")}`), 1, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("error", " This will remove ALL files in:"), 1, 0));
					container.addChild(new Text(t.fg("dim", `   ${init.folderPath}`), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("error", t.bold(" This action cannot be undone.")), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(
						t.fg("text", " Type the initiative name ") +
						t.fg("accent", t.bold(init.name)) +
						t.fg("text", " to confirm:"),
						1, 0,
					));

					const input = new Input();
					container.addChild(input);
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("dim", " Enter to delete · Esc cancel"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => t.fg("error", s)));

					input.onSubmit = async () => {
						const typed = input.getValue().trim();
						if (typed !== init.name) {
							ctx.ui.notify(`Name doesn't match — expected "${init.name}"`, "error");
							return;
						}

						// Delete the folder
						await fs.rm(init.folderPath, { recursive: true, force: true });

						// Clear active state if this was the active initiative
						if (activeInitiative?.name === init.name) {
							activeInitiative = null;
							activeTodo = null;
						}

						await refreshInitiatives(ctx);
						ctx.ui.notify(`🗑️ Deleted: ${init.name}`, "info");
						showInitiativeSelector();
					};

					setActive({
						get focused() { return input.focused; },
						set focused(v: boolean) { input.focused = v; },
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							const kb = getKeybindings();
							if (kb.matches(data, "tui.select.cancel")) {
								showActionMenu(init);
								return;
							}
							input.handleInput(data);
							tui.requestRender();
						},
					});
				};

				// ── New initiative wizard ─────────────────────────────

				interface WizardState {
					team?: string;
					teamSlug?: string;
					name?: string;
					type?: string;
					priority?: string;
					dri?: string;
					stakeholders?: string;
					description?: string;
					tags?: string;
				}

				/** Add accumulated wizard context to a container */
				const addWizardContext = (container: Container, state: WizardState) => {
					const parts: string[] = [];
					if (state.team) parts.push(theme.fg("muted", "Team: ") + theme.fg("dim", state.team));
					if (state.name) parts.push(theme.fg("muted", "Name: ") + theme.fg("dim", state.name));
					if (state.type) parts.push(theme.fg("muted", "Type: ") + theme.fg("dim", state.type));
					if (state.priority) parts.push(theme.fg("muted", "Priority: ") + theme.fg("dim", state.priority));
					if (state.dri) parts.push(theme.fg("muted", "DRI: ") + theme.fg("dim", state.dri));
					if (parts.length > 0) {
						container.addChild(new Text(" " + parts.join(theme.fg("dim", " · ")), 1, 0));
						container.addChild(new Spacer(1));
					}
				};

				/** Helper: create a wizard step with a SelectList */
				const wizardSelectStep = (
					label: string,
					state: WizardState,
					items: SelectItem[],
					onSelect: (value: string) => void,
					onCancel: () => void,
				) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("accent", theme.bold(` New Initiative — ${label}`)), 1, 0));
					container.addChild(new Spacer(1));
					addWizardContext(container, state);

					const selectList = new SelectList(items, items.length, {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});
					selectList.onSelect = (item) => onSelect(item.value);
					selectList.onCancel = onCancel;

					container.addChild(selectList);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " ↑↓ select · Enter confirm · Esc back"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					setActive({
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
					});
				};

				/** Helper: create a wizard step with a text Input */
				const wizardInputStep = (
					label: string,
					prompt: string,
					state: WizardState,
					defaultValue: string,
					optional: boolean,
					onSubmit: (value: string) => void,
					onCancel: () => void,
				) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("accent", theme.bold(` New Initiative — ${label}`)), 1, 0));
					container.addChild(new Spacer(1));
					addWizardContext(container, state);
					container.addChild(new Text(theme.fg("muted", ` ${prompt}`), 1, 0));

					const input = new Input();
					if (defaultValue) input.setValue(defaultValue);
					container.addChild(input);
					container.addChild(new Spacer(1));

					const hint = optional
						? " Enter to continue (empty to skip) · Esc back"
						: " Enter to continue · Esc back";
					container.addChild(new Text(theme.fg("dim", hint), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					input.onSubmit = () => {
						const value = input.getValue().trim();
						if (!optional && !value) return; // required — don't advance
						onSubmit(value);
					};

					setActive({
						get focused() { return input.focused; },
						set focused(v: boolean) { input.focused = v; },
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							const kb = getKeybindings();
							if (kb.matches(data, "tui.select.cancel")) {
								onCancel();
								return;
							}
							input.handleInput(data);
							tui.requestRender();
						},
					});
				};

				// ── Wizard Step 1: Team ──
				const showWizardTeam = (state: WizardState) => {
					wizardSelectStep("Team", state,
						INITIATIVE_TEAMS.map(t => ({ value: t.folder, label: t.display, description: "" })),
						(value) => {
							const team = INITIATIVE_TEAMS.find(t => t.folder === value)!;
							state.team = team.folder;
							state.teamSlug = team.slug;
							showWizardName(state);
						},
						() => showInitiativeSelector(),
					);
				};

				// ── Wizard Step 2: Name ──
				const showWizardName = (state: WizardState) => {
					wizardInputStep("Name", "Initiative name (becomes the folder name):", state,
						state.name || "",
						false,
						(value) => {
							const folderPath = path.join(INITIATIVES_DIR, state.team!, value);
							if (existsSync(folderPath)) {
								ctx.ui.notify(`"${value}" already exists in ${state.team}`, "error");
								return;
							}
							state.name = value;
							showWizardType(state);
						},
						() => showWizardTeam(state),
					);
				};

				// ── Wizard Step 3: Type ──
				const showWizardType = (state: WizardState) => {
					wizardSelectStep("Type", state,
						INITIATIVE_TYPES.map(t => ({ value: t.value, label: t.label, description: t.description })),
						(value) => {
							state.type = value;
							showWizardPriority(state);
						},
						() => showWizardName(state),
					);
				};

				// ── Wizard Step 4: Priority ──
				const showWizardPriority = (state: WizardState) => {
					wizardSelectStep("Priority", state,
						INITIATIVE_PRIORITIES.map(p => ({ value: p.value, label: p.label, description: "" })),
						(value) => {
							state.priority = value;
							showWizardDri(state);
						},
						() => showWizardType(state),
					);
				};

				// ── Wizard Step 5: DRI ──
				const showWizardDri = (state: WizardState) => {
					wizardInputStep("DRI", "Who is directly responsible for the work?", state,
						state.dri || whoami(),
						false,
						(value) => {
							state.dri = value;
							showWizardStakeholders(state);
						},
						() => showWizardPriority(state),
					);
				};

				// ── Wizard Step 6: Stakeholders (optional) ──
				const showWizardStakeholders = (state: WizardState) => {
					wizardInputStep("Stakeholders", "Stakeholders (comma-separated, or Enter to skip):", state,
						state.stakeholders || "",
						true,
						(value) => {
							state.stakeholders = value;
							showWizardDescription(state);
						},
						() => showWizardDri(state),
					);
				};

				// ── Wizard Step 7: Description ──
				const showWizardDescription = (state: WizardState) => {
					wizardInputStep("Description", "One-line summary of what this initiative is about:", state,
						state.description || "",
						false,
						(value) => {
							state.description = value;
							showWizardTags(state);
						},
						() => showWizardStakeholders(state),
					);
				};

				// ── Wizard Step 8: Tags (optional) ──
				const showWizardTags = (state: WizardState) => {
					wizardInputStep("Tags", "Keywords for search (comma-separated, or Enter to skip):", state,
						state.tags || "",
						true,
						(value) => {
							state.tags = value;
							showWizardReview(state);
						},
						() => showWizardDescription(state),
					);
				};

				// ── Wizard Step 9: Review & Create ──
				const showWizardReview = (state: WizardState) => {
					const t = theme;
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("accent", t.bold(" New Initiative — Review")), 1, 0));
					container.addChild(new Spacer(1));

					container.addChild(new Text(` ${typeIcon(state.type!)} ${t.fg("accent", t.bold(state.name!))}`, 1, 0));
					container.addChild(new Text(t.fg("muted", "  Team: ") + t.fg("text", state.team!), 1, 0));
					container.addChild(new Text(
						t.fg("muted", "  Type: ") + t.fg("text", state.type!) +
						t.fg("dim", " · ") +
						t.fg("muted", "Priority: ") + t.fg("text", state.priority!),
						1, 0,
					));
					container.addChild(new Text(t.fg("muted", "  DRI: ") + t.fg("text", state.dri!), 1, 0));
					if (state.stakeholders) {
						container.addChild(new Text(t.fg("muted", "  Stakeholders: ") + t.fg("text", state.stakeholders), 1, 0));
					}
					if (state.tags) {
						container.addChild(new Text(t.fg("muted", "  Tags: ") + t.fg("text", state.tags), 1, 0));
					}
					container.addChild(new Text(t.fg("muted", "  Started: ") + t.fg("dim", todayDate()), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("muted", "  Description:"), 1, 0));
					container.addChild(new Text(t.fg("text", `  ${state.description}`), 1, 0));
					container.addChild(new Spacer(1));

					const items: SelectItem[] = [
						{ value: "create", label: "✅ Create initiative", description: "" },
					];
					const selectList = new SelectList(items, 1, {
						selectedPrefix: (s) => t.fg("accent", s),
						selectedText: (s) => t.fg("accent", s),
						description: (s) => t.fg("muted", s),
						scrollInfo: (s) => t.fg("dim", s),
						noMatch: (s) => t.fg("warning", s),
					});

					selectList.onSelect = async () => {
						try {
							const stakeholderList = state.stakeholders
								? state.stakeholders.split(",").map(s => s.trim()).filter(Boolean)
								: [];
							const tagList = state.tags
								? state.tags.split(",").map(s => s.trim()).filter(Boolean)
								: [];

							await createInitiativeOnDisk({
								teamFolder: state.team!,
								teamSlug: state.teamSlug!,
								name: state.name!,
								type: state.type!,
								priority: state.priority!,
								dri: state.dri!,
								stakeholders: stakeholderList,
								description: state.description!,
								tags: tagList,
							});

							await refreshInitiatives(ctx);
							ctx.ui.notify(`✅ Created: ${state.name}`, "info");

							// Navigate to the new initiative's action menu
							const newInit = findInitiative(cachedInitiatives, state.name!);
							if (newInit) {
								showActionMenu(newInit);
							} else {
								showInitiativeSelector();
							}
						} catch (e: any) {
							ctx.ui.notify(`Error: ${e.message}`, "error");
						}
					};
					selectList.onCancel = () => showWizardTags(state);

					container.addChild(selectList);
					container.addChild(new Spacer(1));
					container.addChild(new Text(t.fg("dim", " Enter to create · Esc back"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));

					setActive({
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
					});
				};

				// ── Initiative selector (entry point) ──
				let selector: InitiativeSelectorComponent;

				const showInitiativeSelector = () => {
					selector = new InitiativeSelectorComponent(
						tui,
						theme,
						cachedInitiatives,
						(initiative) => {
							showActionMenu(initiative);
						},
						() => done(),
						searchTerm || undefined,
						() => {
							const searchVal = selector.getSearchValue();
							showWizardTeam({ name: searchVal || undefined });
						},
					);

					setActive({
						get focused() { return selector.focused; },
						set focused(v: boolean) { selector.focused = v; },
						render: (w: number) => selector.render(w),
						invalidate: () => selector.invalidate(),
						handleInput: (data: string) => selector.handleInput(data),
					});
				};

				showInitiativeSelector();

				// ── Root wrapper ──
				return {
					get focused() { return wrapperFocused; },
					set focused(value: boolean) {
						wrapperFocused = value;
						if (activeComponent && "focused" in activeComponent) activeComponent.focused = value;
					},
					render(width: number) { return activeComponent ? activeComponent.render(width) : []; },
					invalidate() { activeComponent?.invalidate(); },
					handleInput(data: string) { activeComponent?.handleInput?.(data); },
				};
			});

			if (nextPrompt) {
				pi.sendUserMessage(nextPrompt);
			}
		},
	});

	// ─── /todos Command ──────────────────────────────────────────────────

	pi.registerCommand("todos", {
		description: "View & manage todos for the active initiative",
		handler: async (_args, ctx) => {
			await refreshInitiatives(ctx);

			// No active initiative → fall through to /initiatives
			if (!activeInitiative) {
				ctx.ui.notify("No active initiative — opening initiative selector", "info");
				pi.executeCommand("initiatives", "", ctx);
				return;
			}

			const init = activeInitiative;

			if (!ctx.hasUI) {
				const wip = init.todos.filter((t) => t.state === "wip");
				const open = init.todos.filter((t) => t.state === "open");
				const doneList = init.todos.filter((t) => t.state === "done");
				console.log(`Todos for ${init.name} (${wip.length} wip, ${open.length} open, ${doneList.length} done)`);
				for (const t of wip) console.log(`  ◐ ${t.title}${t.assignee ? ` @${t.assignee}` : ""}${isStaleWip(t) ? " ⚠ stale" : ""}`);
				for (const t of open) console.log(`  ○ ${t.title}${t.assignee ? ` @${t.assignee}` : ""}`);
				for (const t of doneList) console.log(`  ✓ ${t.title}`);
				return;
			}

			let nextPrompt: string | null = null;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let activeComponent: {
					render: (width: number) => string[];
					invalidate: () => void;
					handleInput?: (data: string) => void;
				} | null = null;

				const setActive = (comp: typeof activeComponent) => {
					activeComponent = comp;
					tui.requestRender();
				};

				// Refresh todos after mutation
				const refreshTodos = async () => {
					init.todos = await readTodos(init.folderPath, init.name, init.team);
					cachedInitiatives = cachedInitiatives.map((i) =>
						i.name === init.name && i.team === init.team ? { ...i, todos: init.todos } : i
					);
					if (activeInitiative?.name === init.name) activeInitiative = init;
					// Sync activeTodo: clear if no longer WIP or deleted
					if (activeTodo) {
						const fresh = init.todos.find(t => t.id === activeTodo!.id);
						if (fresh && fresh.state === "wip") activeTodo = fresh;
						else activeTodo = null;
					}
					updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);
				};

				// Todo action menu
				const showTodoActions = (todo: Todo) => {
					const items: SelectItem[] = [];

					if (todo.state === "done") {
						items.push({ value: "reopen", label: "🔄 Reopen", description: "Mark as open again" });
					} else {
						items.push({
							value: "assign",
							label: "🤖 Assign to agent",
							description: "Claim, lock to this session, and start working",
						});
						items.push({
							value: "complete",
							label: "✅ Mark as completed",
							description: "For tasks done outside the agent",
						});
					}

					// Delete is always available regardless of state
					items.push({
						value: "delete",
						label: "🗑️ Delete",
						description: "Remove this todo permanently",
					});

					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Spacer(1));

					const stateIcon = todo.state === "wip" ? "◐" : todo.state === "done" ? "✓" : "○";
					container.addChild(new Text(
						theme.fg("accent", theme.bold(` ${stateIcon} ${todo.title}`)),
						1, 0,
					));
					container.addChild(new Spacer(1));

					const selectList = new SelectList(items, items.length, {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					selectList.onSelect = async (item) => {
						switch (item.value) {
							case "assign": {
								const sessionId = ctx.sessionManager.getSessionId();
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const found = todos.find(t => t.id === todo.id);
								if (!found) { ctx.ui.notify("Todo not found", "error"); showTodoList(); return; }
								found.state = "wip";
								found.done = false;
								found.session = sessionId;
								found.ts = found.ts || nowTimestamp();
								await writeTodos(init.folderPath, todos);
								await refreshTodos();

								// Set active initiative + todo and exit TUI
								activeTodo = found;
								activeInitiative = init;
								updateWidget(ctx, cachedInitiatives, activeInitiative, activeTodo);

								const bodyHint = todo.body.trim()
									? ` The todo has a body with details — read it from ${init.folderPath}/todos.md.`
									: "";
								nextPrompt = `I've assigned you todo "${todo.title}" (id: ${todo.id}) from the "${init.name}" initiative. ` +
									`It's now marked as WIP and locked to this session.${bodyHint} ` +
									`Start working on it. When done, mark it complete with initiative_todo toggle.`;
								done();
								break;
							}
							case "complete": {
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const found = todos.find(t => t.id === todo.id);
								if (!found) { ctx.ui.notify("Todo not found", "error"); showTodoList(); return; }
								found.state = "done";
								found.done = true;
								found.session = "";
								found.ts = "";
								await writeTodos(init.folderPath, todos);
								await refreshTodos();
								ctx.ui.notify(`Completed: ${todo.title}`, "info");
								showTodoList();
								break;
							}
							case "reopen": {
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const found = todos.find(t => t.id === todo.id);
								if (!found) { ctx.ui.notify("Todo not found", "error"); showTodoList(); return; }
								found.state = "open";
								found.done = false;
								found.session = "";
								found.ts = "";
								await writeTodos(init.folderPath, todos);
								await refreshTodos();
								ctx.ui.notify(`Reopened: ${todo.title}`, "info");
								showTodoList();
								break;
							}
							case "delete": {
								const todos = await readTodos(init.folderPath, init.name, init.team);
								const idx = todos.findIndex(t => t.id === todo.id);
								if (idx === -1) { ctx.ui.notify("Todo not found", "error"); showTodoList(); return; }
								todos.splice(idx, 1);
								await writeTodos(init.folderPath, todos);
								await refreshTodos();
								ctx.ui.notify(`Deleted: ${todo.title}`, "info");
								showTodoList();
								break;
							}
						}
					};

					selectList.onCancel = () => showTodoList();

					container.addChild(selectList);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", " Enter select · Esc back"), 1, 0));
					container.addChild(new Spacer(1));
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					setActive({
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
					});
				};

				// Todo list
				const showTodoList = () => {
					const panel = createTodoSplitPanel(
						init.name,
						() => init.todos,
						theme,
						tui,
						(todo) => showTodoActions(todo),
						() => done(),
					);

					setActive({
						render: (w) => panel.render(w),
						invalidate: () => panel.invalidate(),
						handleInput: (data) => panel.handleInput(data),
					});
				};

				showTodoList();

				return {
					get focused() { return true; },
					set focused(_v: boolean) {},
					render(width: number) { return activeComponent ? activeComponent.render(width) : []; },
					invalidate() { activeComponent?.invalidate(); },
					handleInput(data: string) { activeComponent?.handleInput?.(data); },
				};
			});

			if (nextPrompt) {
				pi.sendUserMessage(nextPrompt);
			}
		},
	});

	// ─── initiative_create Tool ──────────────────────────────────────────

	const InitiativeCreateParams = Type.Object({
		name: Type.String({ description: "Initiative name (becomes the folder name)" }),
		team: Type.String({ description: "Team: 'Data Platform', 'Ops Data', or 'Cross-Team'" }),
		description: Type.String({ description: "One-paragraph summary of the initiative" }),
		type: Type.Optional(Type.String({ description: "Type: project (default), exploration, or request" })),
		priority: Type.Optional(Type.String({ description: "Priority: high (default), medium, or low" })),
		dri: Type.Optional(Type.String({ description: "DRI (directly responsible individual). Defaults to OS username." })),
		stakeholders: Type.Optional(Type.String({ description: "Comma-separated list of stakeholders" })),
		tags: Type.Optional(Type.String({ description: "Comma-separated list of tags/keywords" })),
	});

	pi.registerTool({
		name: "initiative_create",
		label: "Create Initiative",
		description:
			`Create a new initiative (${INITIATIVES_DIR}). ` +
			"Creates a folder with index.md containing YAML frontmatter and a description. " +
			"Required: name, team, description. " +
			"Teams: 'Data Platform', 'Ops Data', 'Cross-Team'. " +
			"Types: project (default), exploration, request. " +
			"Priorities: high, medium (default), low.",
		parameters: InitiativeCreateParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Resolve team
			const team = resolveTeam(params.team);
			if (!team) {
				const valid = INITIATIVE_TEAMS.map(t => t.display).join(", ");
				return {
					content: [{ type: "text", text: `Invalid team "${params.team}". Valid: ${valid}` }],
					details: { error: true },
				};
			}

			// Validate type
			const initType = params.type?.toLowerCase() || "project";
			if (!["project", "exploration", "request"].includes(initType)) {
				return {
					content: [{ type: "text", text: `Invalid type "${params.type}". Valid: project, exploration, request` }],
					details: { error: true },
				};
			}

			// Validate priority
			const priority = params.priority?.toLowerCase() || "medium";
			if (!["high", "medium", "low"].includes(priority)) {
				return {
					content: [{ type: "text", text: `Invalid priority "${params.priority}". Valid: high, medium, low` }],
					details: { error: true },
				};
			}

			const dri = params.dri || whoami();
			const stakeholders = params.stakeholders
				? params.stakeholders.split(",").map(s => s.trim()).filter(Boolean)
				: [];
			const tags = params.tags
				? params.tags.split(",").map(s => s.trim()).filter(Boolean)
				: [];

			try {
				const folderPath = await createInitiativeOnDisk({
					teamFolder: team.folder,
					teamSlug: team.slug,
					name: params.name,
					type: initType,
					priority,
					dri,
					stakeholders,
					description: params.description,
					tags,
				});

				await refreshInitiatives(ctx);

				return {
					content: [{
						type: "text",
						text: `Created initiative "${params.name}" in ${team.display}.\nFolder: ${folderPath}\nStatus: active | Type: ${initType} | Priority: ${priority} | DRI: ${dri}`,
					}],
					details: {
						action: "create",
						initiative: params.name,
						team: team.display,
						folderPath,
					},
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error creating initiative: ${e.message}` }],
					details: { error: true },
				};
			}
		},

		renderCall(args, theme) {
			const name = typeof args.name === "string" ? args.name : "";
			const team = typeof args.team === "string" ? args.team : "";
			let text = theme.fg("toolTitle", theme.bold("initiative_create "));
			if (name) text += theme.fg("accent", name);
			if (team) text += " " + theme.fg("dim", `(${team})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Record<string, any> | undefined;
			if (details?.error) {
				const text = result.content[0];
				return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
			}
			let text = theme.fg("success", "✅ ") +
				theme.fg("muted", "Created ") +
				theme.fg("accent", details?.initiative ?? "") +
				theme.fg("muted", " in ") +
				theme.fg("dim", details?.team ?? "");
			if (expanded) {
				const raw = result.content[0];
				if (raw?.type === "text") text += "\n" + theme.fg("dim", raw.text);
			}
			return new Text(text, 0, 0);
		},
	});
}
