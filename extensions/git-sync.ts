import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const STATUS_KEY = "git-sync";
const START = "# >>> pi-config-sync managed — do not edit inside this block";
const END = "# <<< pi-config-sync managed";
const LEGACY_MARKERS: Array<[string, string]> = [["# >>> pi-git-sync managed — do not edit inside this block", "# <<< pi-git-sync managed"]];
const DEFAULT_PATHS = [".gitignore", ".gitattributes", "settings.json", "AGENTS.md", "git-sync.jsonc", "extensions", "chains", "prompts", "themes", "skills"];
const DEFAULT_MACHINE_LOCAL = ["lastChangelogVersion", "extensionChangelogVersions"];
const ATTRIBUTES_LINE = "settings.json filter=pi-config-sync merge=pi-config-sync";
const LEGACY_ATTRIBUTES_LINES = ["settings.json filter=pi-config-sync"];
const RUNTIME_LOG_DIR = "logs";
const IGNORE_DENY = [`**/${RUNTIME_LOG_DIR}/`, "auth*", "mcp-auth*", "mcp.log*", "*token*", "*secret*", "*credential*", "*.env", "*.env.*", "*.local.json", "**/node_modules/", ".DS_Store"];
const LIKELY_SYNC_REPO_NAMES = ["pi-agent-config", "my-pi-config", "pi-config", "dotfiles-pi"];

export interface GitSyncConfig { autoSyncIntervalMinutes?: number; extraPaths?: string[]; includeHostname?: boolean; machineLocalSettings?: string[]; nodePath?: string; warnOnPublicRemote?: boolean }
export interface GhClient { available(): Promise<boolean>; currentUser(): Promise<string>; repoExists(id: string): Promise<boolean>; isPrivate(id: string): Promise<boolean | undefined>; createPrivateRepo(id: string): Promise<void>; remoteUrl(id: string): string }
export interface Deps { dir?: string; gh?: GhClient; notify?: (message: string, level: Level) => void; runtime?: Runtime }
export interface Runtime { bundled: boolean; execPath: string; pathEnv?: string; platform?: NodeJS.Platform }
type Level = "info" | "warning" | "error";
type Ctx = ExtensionContext | ExtensionCommandContext;

export default function gitSync(pi: ExtensionAPI) {
	pi.registerCommand("gitsync", { description: "Securely sync pi config (init, link, status, sync, push, pull)", getArgumentCompletions: prefix => {
		const entries = ["init", "link", "status", "sync", "push", "pull"].map(value => ({ value, label: value })).filter(x => x.value.startsWith(prefix.trim()));
		return entries.length ? entries : null;
	}, handler: async (args, ctx) => {
		const [command = "status", ...rest] = args.trim().split(/\s+/); const arg = rest.join(" ");
		try { await withLock(ctx, async () => {
			if (command === "init") return runInit(arg, ctx);
			if (command === "link") return runLink(arg, ctx);
			if (command === "status") return showStatus(ctx);
			if (command === "sync") return runSync(ctx, { auto: false, push: true });
			if (command === "push") return runSync(ctx, { auto: false, push: true, skipPull: true });
			if (command === "pull") return runSync(ctx, { auto: false, push: false });
			throw new Error("Unknown command. Usage: /gitsync [init|link|status|sync|push|pull]");
		}); } catch (error) { notify(ctx, `git-sync: ${message(error)}`, "error"); }
	} });
	pi.on("session_start", async (_event, ctx) => { if (await shouldAutoSync()) try { await withLock(ctx, async () => { await writeState({ lastAutoSyncAt: new Date().toISOString() }); await runSync(ctx, { auto: true, push: true }); }); } catch (error) { notify(ctx, `git-sync skipped: ${message(error)}`, "warning"); } });
	pi.on("session_shutdown", async (event, ctx) => { const reason = typeof event === "object" && event ? (event as { reason?: string }).reason : undefined; if (reason === "reload" || isSubagentChild() || !(await isSyncableRepo())) return; try { await withLock(ctx, async () => { await prepareCommit(undefined, ctx); await commitLocalChanges(undefined, undefined, ctx); await bestEffortPush(); }); } catch {} });
}

function dirOf(deps?: Deps) { const value = deps?.dir ?? process.env.PI_CODING_AGENT_DIR?.trim(); return !value ? path.join(os.homedir(), ".pi", "agent") : value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : path.resolve(value); }
function gitEnv(dir: string) { return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: path.dirname(dir) }; }
function git(args: string[], dir: string, timeout = 10_000, env: Record<string, string> = {}) { return exec("git", args, { cwd: dir, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...gitEnv(dir), ...env } }); }
function gitRaw(args: string[], dir: string) { return exec("git", args, { cwd: dir, timeout: 10_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer", env: gitEnv(dir) }) as unknown as Promise<{ stdout: Buffer; stderr: Buffer }>; }
function notify(ctx: Ctx | undefined, text: string, level: Level, deps?: Deps) { if (deps?.notify) deps.notify(text, level); else if (ctx?.hasUI) ctx.ui.notify(text, level); }
const warnedOnce = new Set<string>();
function warnOnce(ctx: Ctx | undefined, text: string, deps: Deps | undefined, key = text) { if (warnedOnce.has(key) || !(deps?.notify || ctx?.hasUI)) return; warnedOnce.add(key); notify(ctx, text, "warning", deps); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function stateDir(dir: string) { return path.join(dir, ".git-sync"); }
function statePath(dir: string) { return path.join(stateDir(dir), "state.json"); }
function lockPath(dir: string) { return path.join(stateDir(dir), "lock"); }
function isSubagentChild() { return Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0; }

export function isDenied(file: string) { const parts = file.toLowerCase().replaceAll("\\", "/").split("/").filter(Boolean); return parts.some(part => ["sessions", "state", "npm", "git", "bin", ".git-sync", "node_modules", RUNTIME_LOG_DIR].includes(part) || part.startsWith("auth") || part.startsWith("mcp-auth") || part.startsWith("mcp.log") || part.includes("token") || part.includes("secret") || part.includes("credential") || part === ".env" || part.includes(".env.") || part.endsWith(".env") || part.endsWith(".local.json")); }
function validExtra(entry: string) { return entry.trim() !== "" && !entry.includes("..") && !path.isAbsolute(entry) && !isDenied(entry); }
export function stripJsonComments(input: string) { let out = "", quote = "", escaped = false; for (let i = 0; i < input.length; i++) { const c = input[i]!, next = input[i + 1]; if (quote) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === quote) quote = ""; continue; } if (c === '"' || c === "'") { quote = c; out += c; } else if (c === "/" && next === "/") { while (i < input.length && input[i] !== "\n") i++; out += "\n"; } else if (c === "/" && next === "*") { i += 2; while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++; i++; } else out += c; } return out; }
/** Built-in machine-local keys always apply; machineLocalSettings adds to them. */
export function machineKeys(config: GitSyncConfig) { return [...new Set([...DEFAULT_MACHINE_LOCAL, ...(config.machineLocalSettings ?? [])])]; }
export async function readConfig(deps?: Deps, ctx?: Ctx): Promise<GitSyncConfig> { const dir = dirOf(deps); try { const raw = JSON.parse(stripJsonComments(await fs.readFile(path.join(dir, "git-sync.jsonc"), "utf8"))) as GitSyncConfig; const extras = (raw.extraPaths ?? []).filter(validExtra); if (extras.length !== (raw.extraPaths ?? []).length) warnOnce(ctx, "git-sync: unsafe extraPaths were ignored", deps, `${dir}|extras`); let machineLocalSettings: string[] | undefined; if (Array.isArray(raw.machineLocalSettings)) { machineLocalSettings = raw.machineLocalSettings.filter((key): key is string => typeof key === "string" && key.trim() !== ""); if (machineLocalSettings.length !== raw.machineLocalSettings.length) warnOnce(ctx, "git-sync: invalid machineLocalSettings entries were ignored", deps, `${dir}|machineKeys`); } let nodePath: string | undefined; if (raw.nodePath !== undefined) { if (typeof raw.nodePath === "string" && raw.nodePath.trim() !== "") nodePath = raw.nodePath.trim(); else warnOnce(ctx, "git-sync: invalid nodePath was ignored", deps, `${dir}|nodePath`); } return { ...raw, extraPaths: extras, machineLocalSettings, nodePath }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; warnOnce(ctx, "git-sync: invalid git-sync.jsonc; using defaults", deps, `${dir}|invalid`); return {}; } }
function allowRules(entry: string) { const segments = entry.replace(/\/+$/, "").split("/").filter(Boolean); const rules: string[] = []; let prefix = ""; for (let i = 0; i < segments.length; i++) { prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]!; if (i < segments.length - 1) rules.push(`!${prefix}/`); else rules.push(`!${prefix}`, `!${prefix}/`, `!${prefix}/**`); } return rules; }
export async function ensureIgnoreRules(dir = dirOf(), config: GitSyncConfig = {}) { const file = path.join(dir, ".gitignore"); let existing = ""; try { existing = await fs.readFile(file, "utf8"); } catch {} const paths = [...DEFAULT_PATHS, ...(config.extraPaths ?? []).filter(validExtra)]; const lines = [START, "*", ...paths.flatMap(allowRules), "# hard denylist — re-ignored even inside allowed dirs", ...IGNORE_DENY, END]; const block = lines.join("\n"); let base = existing, replaced = false; for (const [start, end] of [[START, END] as [string, string], ...LEGACY_MARKERS]) { const re = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`); if (re.test(base)) { base = base.replace(re, ""); replaced = true; } } await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file, (replaced ? base : base.replace(/\s*$/, "\n")) + block + "\n"); }
export async function ensureInfoExclude(dir = dirOf()) { const file = path.join(dir, ".git", "info", "exclude"); await fs.mkdir(path.dirname(file), { recursive: true }); let current = ""; try { current = await fs.readFile(file, "utf8"); } catch {} const missing = IGNORE_DENY.filter(rule => !current.split("\n").includes(rule)); if (missing.length) await fs.writeFile(file, current.replace(/\s*$/, "\n") + missing.join("\n") + "\n"); }
function escapeRegExp(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export async function ensureAttributes(dir = dirOf()) { const file = path.join(dir, ".gitattributes"); let current = ""; try { current = await fs.readFile(file, "utf8"); } catch {} const lines = current.split(/\r?\n/); if (lines.includes(ATTRIBUTES_LINE) && !lines.some(line => LEGACY_ATTRIBUTES_LINES.includes(line))) return; const kept = lines.filter(line => line !== ATTRIBUTES_LINE && !LEGACY_ATTRIBUTES_LINES.includes(line)).join("\n"); await fs.writeFile(file, `${kept.replace(/\s*$/, "")}\n${ATTRIBUTES_LINE}\n`.replace(/^\n/, "")); }
function filterSource(keys: string[]) { return `import fs from "node:fs";
const keys=${JSON.stringify(keys)};
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); const raw=Buffer.concat(chunks);
try { const value=JSON.parse(raw.toString("utf8")); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not object"); if (process.argv[2] === "clean") { for (const key of keys) delete value[key]; process.stdout.write(JSON.stringify(value, null, 2)+"\\n"); } else if (process.argv[2] === "smudge") { const sidecar=JSON.parse(fs.readFileSync(new URL("settings.machine.json", import.meta.url), "utf8")); if (!sidecar || Array.isArray(sidecar) || typeof sidecar !== "object") throw new Error("bad sidecar"); process.stdout.write(JSON.stringify({...value, ...sidecar}, null, 2)+"\\n"); } else process.stdout.write(raw); } catch { process.stdout.write(raw); }
`; }
/**
 * Git merge driver for settings.json (`%O %A %B`): a key-level three-way JSON merge, so edits to different keys on
 * different machines never conflict. Lists merge item by item (additions and removals from both sides apply).
 * Machine-local keys are dropped from every side, since they never belong in the committed form. Keys changed
 * differently on both sides are recorded in merge-conflicts.json; with PI_CONFIG_SYNC_PREFER=ours|theirs (set by the
 * sync) that side's value is kept, otherwise (a manual git merge) it falls back to a text merge with conflict markers.
 */
function mergeSource(keys: string[]) { return `import fs from "node:fs"; import { execFileSync } from "node:child_process";
const keys=${JSON.stringify(keys)};
const [basePath, oursPath, theirsPath] = process.argv.slice(2);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (a, b) => { if (a === b) return true; if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i])); if (!isObject(a) || !isObject(b)) return false; const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every(key => Object.hasOwn(b, key) && equal(a[key], b[key])); };
const read = file => { const value = JSON.parse(fs.readFileSync(file, "utf8")); if (!isObject(value)) throw new Error("not an object"); for (const key of keys) delete value[key]; return value; };
const conflicts = [], prefer = process.env.PI_CONFIG_SYNC_PREFER;
const mergeList = (base, ours, theirs) => { const id = value => JSON.stringify(value), inBase = new Set(base.map(id)), inTheirs = new Set(theirs.map(id)); const out = ours.filter(value => !inBase.has(id(value)) || inTheirs.has(id(value))), have = new Set(out.map(id)); for (const value of theirs) if (!inBase.has(id(value)) && !have.has(id(value))) { out.push(value); have.add(id(value)); } return out; };
const merge = (base, ours, theirs, at) => { if (equal(ours, theirs)) return ours; if (equal(base, ours)) return theirs; if (equal(base, theirs)) return ours; if (Array.isArray(ours) && Array.isArray(theirs) && (base === undefined || Array.isArray(base))) return mergeList(base ?? [], ours, theirs); if (isObject(ours) && isObject(theirs)) { const out = {}, from = isObject(base) ? base : {}; for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) { const value = merge(from[key], ours[key], theirs[key], [...at, key]); if (value !== undefined) out[key] = value; } return out; } conflicts.push(at.join(".") || "(whole file)"); return prefer === "theirs" ? theirs : ours; };
const textMerge = () => { try { execFileSync("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", oursPath, basePath, theirsPath], { stdio: "ignore" }); return true; } catch { return false; } };
let merged;
try { let base = {}; try { base = read(basePath); } catch {} merged = merge(base, read(oursPath), read(theirsPath), []); } catch { process.exit(textMerge() ? 0 : 1); }
if (conflicts.length) { const report = new URL("merge-conflicts.json", import.meta.url); let seen = []; try { seen = JSON.parse(fs.readFileSync(report, "utf8")); } catch {} fs.writeFileSync(report, JSON.stringify([...new Set([...seen, ...conflicts])])+"\\n"); }
if (!conflicts.length || prefer === "ours" || prefer === "theirs") { fs.writeFileSync(oursPath, JSON.stringify(merged, null, 2)+"\\n"); process.exit(0); }
textMerge(); process.exit(1);
`; }
/** pi shipped as a single executable (Node SEA or compiled Bun binary): process.execPath is pi itself and cannot run the filter script. */
async function detectRuntime(): Promise<Runtime> { const execPath = process.execPath; if (process.versions.bun) return { bundled: !/^bun/i.test(path.basename(execPath)), execPath }; try { return { bundled: (await import("node:sea")).isSea(), execPath }; } catch { return { bundled: false, execPath }; } }
export async function findOnPath(name: string, pathEnv = process.env.PATH ?? "", platform = process.platform) { const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name]; for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) for (const candidate of names) { const full = path.join(directory, candidate); try { await fs.access(full, fs.constants.X_OK); return full; } catch {} } return undefined; }
export async function filterInterpreter(config: GitSyncConfig, runtime: Runtime, ctx?: Ctx, deps?: Deps) { if (config.nodePath) return config.nodePath; if (!runtime.bundled) return runtime.execPath; const found = await findOnPath("node", runtime.pathEnv, runtime.platform); if (found) return found; warnOnce(ctx, "git-sync: pi runs as a bundled executable and no node was found on PATH; settings.json filter is disabled until nodePath is set in git-sync.jsonc", deps, "nodePath"); return "node"; }
async function gitConfigValue(key: string, dir: string) { try { return (await git(["config", "--get", key], dir)).stdout.trim(); } catch { return undefined; } }
export async function ensureFilter(dir = dirOf(), config: GitSyncConfig = {}, ctx?: Ctx, deps?: Deps) { if (!(await hasDotGit(dir))) return; await fs.mkdir(stateDir(dir), { recursive: true }); const script = path.join(stateDir(dir), "filter.mjs"), mergeScript = path.join(stateDir(dir), "merge.mjs"); let configured = await writeIfChanged(script, filterSource(machineKeys(config))); await writeIfChanged(mergeScript, mergeSource(machineKeys(config))); const interpreter = await filterInterpreter(config, deps?.runtime ?? await detectRuntime(), ctx, deps); const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`; const values: Record<string, string> = { "filter.pi-config-sync.clean": `${quoted(interpreter)} ${quoted(script)} clean`, "filter.pi-config-sync.smudge": `${quoted(interpreter)} ${quoted(script)} smudge`, "filter.pi-config-sync.required": "false", "merge.pi-config-sync.name": "pi-config-sync settings.json key-level merge", "merge.pi-config-sync.driver": `${quoted(interpreter)} ${quoted(mergeScript)} %O %A %B` }; for (const [key, value] of Object.entries(values)) if (await gitConfigValue(key, dir) !== value) { await git(["config", key, value], dir); configured = true; } if (configured) try { await git(["add", "--renormalize", "settings.json"], dir); } catch {} }
export async function refreshMachineSidecar(dir = dirOf(), config: GitSyncConfig = {}) { try { const settings = JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8")) as Record<string, unknown>; if (!settings || Array.isArray(settings) || typeof settings !== "object") return; const sidecar = Object.fromEntries(machineKeys(config).filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]])); const output = JSON.stringify(sidecar, null, 2)+"\n", file = path.join(stateDir(dir), "settings.machine.json"); await fs.mkdir(stateDir(dir), { recursive: true }); try { if (await fs.readFile(file, "utf8") === output) return; } catch {} await fs.writeFile(file, output); } catch {} }
async function prepareCommit(deps?: Deps, ctx?: Ctx) { const config = await readConfig(deps, ctx), dir = dirOf(deps); await ensureIgnoreRules(dir, config); await ensureInfoExclude(dir); await ensureAttributes(dir); await ensureFilter(dir, config, ctx, deps); await refreshMachineSidecar(dir, config); return config; }
export async function stagedSecretFiles(dir = dirOf()) { const { stdout } = await git(["diff", "--cached", "--name-only", "--diff-filter=d", "-z"], dir); return stdout.split("\0").filter(Boolean).filter(isDenied); }
function allowedRoots(config: GitSyncConfig) { return new Set([...DEFAULT_PATHS, ...(config.extraPaths ?? []).filter(validExtra)].map(entry => entry.split("/").filter(Boolean)[0]!)); }
function inAllowedRoot(file: string, roots: Set<string>) { const parts = file.split("/").filter(Boolean); return parts.length >= 2 && roots.has(parts[0]!) && !parts.includes("node_modules") && !parts.includes(RUNTIME_LOG_DIR) && !parts.includes(".DS_Store"); }
async function statusEntries(dir: string, args: string[]) { return (await git(["status", "--porcelain", "-z", ...args], dir)).stdout.split("\0").filter(Boolean).map(entry => ({ code: entry.slice(0, 2), file: entry.slice(3) })); }
/** Untracked directories inside allowed roots that are git repositories themselves. They are excluded from staging: a gitlink pointer is useless on other machines, and one without commits makes git add fail. */
async function untrackedNestedRepos(dir: string, roots: Set<string>) { const found: string[] = []; try { for (const { code, file } of await statusEntries(dir, ["--untracked-files=all"])) if (code === "??" && file.endsWith("/") && inAllowedRoot(file, roots)) { try { await fs.access(path.join(dir, file, ".git")); found.push(file.replace(/\/$/, "")); } catch {} } } catch {} return found; }
/** Allowlisted content that will not sync: nested repositories (skipped, or a legacy pointer) and names caught by the secret denylist. */
export async function syncGaps(dir = dirOf(), config: GitSyncConfig = {}) { const roots = allowedRoots(config), nested = new Set(await untrackedNestedRepos(dir, roots)), denied: string[] = []; try { for (const entry of (await git(["ls-files", "-s", "-z"], dir)).stdout.split("\0").filter(Boolean)) { const [meta, file] = entry.split("\t"); if (meta?.startsWith("160000") && file) nested.add(file); } } catch {} try { for (const { code, file } of await statusEntries(dir, ["--ignored"])) if (code === "!!" && inAllowedRoot(file, roots) && isDenied(file)) denied.push(file); } catch {} return { denied, nested: [...nested].sort() }; }
function gapMessages(gaps: { denied: string[]; nested: string[] }) { const lines: string[] = []; if (gaps.nested.length) lines.push(`nested git repositories are skipped: ${gaps.nested.join(", ")}. Remove the inner .git directory to sync them.`); if (gaps.denied.length) lines.push(`allowlisted paths skipped because their name looks sensitive: ${gaps.denied.join(", ")}. Rename them to sync.`); return lines; }
export async function trackedSecretFiles(dir = dirOf()) { try { const { stdout } = await git(["ls-files", "-z"], dir); return stdout.split("\0").filter(Boolean).filter(isDenied); } catch { return []; } }
export async function commitLocalChanges(deps?: Deps, commitMessage?: string, ctx?: Ctx) { const dir = dirOf(deps); await prepareCommit(deps, ctx); const status = (await git(["status", "--porcelain"], dir)).stdout.trim(); if (!status) return false; const skipped = await untrackedNestedRepos(dir, allowedRoots(await readConfig(deps, ctx))); await git(["add", "-A", "--", ".", ...skipped.map(entry => `:(exclude)${entry}`)], dir); const bad = await stagedSecretFiles(dir); if (bad.length) { await git(["reset"], dir); throw new Error(`REFUSED to commit sensitive paths: ${bad.join(", ")}. Remove with git rm --cached <file>.`); } if (!(await git(["diff", "--cached", "--name-only"], dir)).stdout.trim()) return false; const config = await readConfig(deps, ctx); const suffix = config.includeHostname === false ? "" : ` from ${os.hostname()}`; await git(["commit", "-m", commitMessage ?? `pi config: auto-sync${suffix}`], dir); return true; }
async function hasDotGit(dir: string) { try { await fs.access(path.join(dir, ".git")); return true; } catch { return false; } }
async function hasCommits(dir: string) { try { await git(["rev-parse", "HEAD"], dir); return true; } catch { return false; } }
async function isSyncableRepo(dir = dirOf()) { if (!(await hasDotGit(dir))) return false; try { const { stdout } = await git(["remote"], dir); return stdout.split("\n").includes("origin"); } catch { return false; } }
async function upstreamRef(dir: string) { try { return (await git(["rev-parse", "--abbrev-ref", "@{u}"], dir)).stdout.trim(); } catch { return undefined; } }
async function counts(upstream: string, dir: string) { const { stdout } = await git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], dir); const [behind = "0", ahead = "0"] = stdout.trim().split(/\s+/); return { behind: Number(behind), ahead: Number(ahead) }; }
async function fetchOrigin(dir: string) { try { await git(["fetch", "origin"], dir); return true; } catch { return false; } }
/** True when a write was needed. */
async function writeIfChanged(file: string, content: string) { try { if (await fs.readFile(file, "utf8") === content) return false; } catch {} await fs.writeFile(file, content); return true; }
/** Pulled settings.json from an older package version can still carry machine-local keys; re-run the clean filter and commit if that changes the blob. */
async function normalizeSettings(deps?: Deps, ctx?: Ctx) { const dir = dirOf(deps); try { await git(["add", "--renormalize", "--", "settings.json"], dir); } catch { return false; } return commitLocalChanges(deps, undefined, ctx); }
/** A conflict the sync resolved by keeping the newer side; the other side is saved under the integration's backupDir. */
export interface ResolvedConflict { file: string; kept: "local" | "remote"; keys: string[] }
export interface IntegrateResult { resolved: ResolvedConflict[]; backupDir?: string }
type Side = ResolvedConflict["kept"];
async function lastChange(ref: string, file: string, dir: string) { try { return Number((await git(["log", "-1", "--format=%ct", ref, "--", file], dir)).stdout.trim()) || 0; } catch { return 0; } }
/** The side whose latest commit touching the file is newer; ties keep the remote version, which other machines already have. */
async function newerSide(local: string, remote: string, file: string, dir: string): Promise<Side> { return (await lastChange(local, file, dir)) > (await lastChange(remote, file, dir)) ? "local" : "remote"; }
async function unmergedStages(dir: string) { const stages = new Map<string, Set<number>>(); for (const entry of (await git(["ls-files", "-u", "-z"], dir)).stdout.split("\0").filter(Boolean)) { const [meta, file] = entry.split("\t") as [string, string]; const stage = Number(meta.split(" ")[2]); if (!stages.has(file)) stages.set(file, new Set()); stages.get(file)!.add(stage); } return stages; }
/** Resolve one conflicted path toward `kept`: non-conflicting hunks from both sides still merge; whole-file fallback for binaries, deletions, and settings.json. */
async function resolveFile(file: string, kept: Side, stages: Set<number>, dir: string) {
	const stage = kept === "local" ? 2 : 3;
	if (!stages.has(stage)) { await git(["rm", "--quiet", "--", file], dir); return; }
	if (file !== "settings.json" && stages.has(1) && stages.has(2) && stages.has(3)) {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-config-sync-merge-"));
		try {
			const [base, ours, theirs] = [1, 2, 3].map(n => path.join(tmp, String(n)));
			for (const [n, target] of [[1, base], [2, ours], [3, theirs]] as const) await fs.writeFile(target!, (await gitRaw(["show", `:${n}:${file}`], dir)).stdout);
			await git(["merge-file", kept === "local" ? "--ours" : "--theirs", ours!, base!, theirs!], dir);
			await fs.writeFile(path.join(dir, file), await fs.readFile(ours!));
			await git(["add", "--", file], dir);
			return;
		} catch {} finally { await fs.rm(tmp, { recursive: true, force: true }); }
	}
	await git(["checkout", kept === "local" ? "--ours" : "--theirs", "--", file], dir);
	await git(["add", "--", file], dir);
}
async function backupLosers(resolved: ResolvedConflict[], local: string, remote: string, dir: string) {
	const backupDir = path.join(stateDir(dir), "conflicts", new Date().toISOString().replace(/[:.]/g, "-"));
	for (const { file, kept } of resolved) {
		let content: Buffer; try { content = (await gitRaw(["show", `${kept === "local" ? remote : local}:${file}`], dir)).stdout; } catch { continue; }
		await fs.mkdir(path.dirname(path.join(backupDir, file)), { recursive: true }); await fs.writeFile(path.join(backupDir, file), content);
	}
	return backupDir;
}
/**
 * Fast-forward when possible, otherwise one merge commit. A single merge resolves each conflict once and never checks
 * out older remote settings.json blobs, which may still carry machine-local keys written by older versions. Anything
 * changed differently on both machines keeps the newer side (per file, by latest commit time); the other side is saved
 * under .git-sync/conflicts/ so nothing is lost. Throws, leaving the repository as it was, only if git itself fails.
 */
async function integrate(upstream: string, dir: string): Promise<IntegrateResult> {
	try { await git(["merge", "--ff-only", upstream], dir); return { resolved: [] }; } catch {}
	const local = (await git(["rev-parse", "HEAD"], dir)).stdout.trim(), remote = (await git(["rev-parse", upstream], dir)).stdout.trim();
	const report = path.join(stateDir(dir), "merge-conflicts.json"); await fs.rm(report, { force: true });
	const settingsSide = await newerSide(local, remote, "settings.json", dir);
	let mergeError: unknown;
	try { await git(["merge", "--no-edit", "-m", `pi config: merge ${upstream}`, upstream], dir, 60_000, { PI_CONFIG_SYNC_PREFER: settingsSide === "local" ? "ours" : "theirs" }); } catch (error) { mergeError = error; }
	let settingsKeys: string[] = []; try { settingsKeys = JSON.parse(await fs.readFile(report, "utf8")) as string[]; } catch {} await fs.rm(report, { force: true });
	const resolved: ResolvedConflict[] = settingsKeys.length ? [{ file: "settings.json", kept: settingsSide, keys: settingsKeys }] : [];
	if (mergeError) {
		try {
			const unmerged = await unmergedStages(dir);
			if (!unmerged.size) throw mergeError;
			for (const [file, stages] of unmerged) {
				const kept = await newerSide(local, remote, file, dir);
				await resolveFile(file, kept, stages, dir);
				const existing = resolved.find(entry => entry.file === file);
				if (existing) existing.kept = kept; else resolved.push({ file, kept, keys: [] });
			}
			await git(["commit", "--no-edit"], dir);
		} catch (error) {
			try { await git(["merge", "--abort"], dir); } catch {}
			const detail = String((error as { stderr?: string }).stderr ?? message(error)).split("\n").map(line => line.trim()).find(line => /^(error|fatal):/.test(line)) ?? message(error);
			throw new Error(`can't pull remote changes: ${detail}. Nothing was changed locally. Check cd ${dir} && git status, then run /gitsync sync again.`);
		}
	}
	return resolved.length ? { resolved, backupDir: await backupLosers(resolved, local, remote, dir) } : { resolved };
}
export function resolvedMessage(result: IntegrateResult) { const items = result.resolved.map(({ file, kept, keys }) => `${file}${keys.length ? ` (${keys.map(key => `"${key}"`).join(", ")})` : ""}: kept the ${kept === "local" ? "local" : "remote"} version`); return `git-sync: changed differently on two machines, kept the newer change — ${items.join("; ")}. The other version is saved in ${result.backupDir}.`; }
async function assertSafeToPush(dir: string) {
	const tracked = (await git(["ls-tree", "-r", "--name-only", "-z", "HEAD"], dir)).stdout;
	const denied = new Set(tracked.split("\0").filter(Boolean).filter(isDenied));
	const commits = (await git(["rev-list", "HEAD", "--not", "--remotes=origin"], dir)).stdout.trim().split("\n").filter(Boolean);
	for (const commit of commits) {
		const changed = (await git(["diff-tree", "--root", "-m", "-r", "--no-commit-id", "--no-renames", "--name-only", "--diff-filter=d", "-z", commit], dir)).stdout;
		for (const file of changed.split("\0").filter(Boolean).filter(isDenied)) denied.add(file);
	}
	if (denied.size) throw new Error(`REFUSED to push denied paths in the current tree or outgoing history: ${[...denied].join(", ")}. Untrack current files and remove any unpushed commits containing them before retrying; local files are not deleted.`);
}
async function push(first: boolean, dir: string) { await assertSafeToPush(dir); try { await git(first ? ["push", "-u", "origin", "HEAD"] : ["push"], dir, 15_000); return true; } catch { return false; } }
async function bestEffortPush(deps?: Deps) { const dir = dirOf(deps); const upstream = await upstreamRef(dir); if (!upstream) return push(true, dir); const { ahead, behind } = await counts(upstream, dir); return ahead > 0 && behind === 0 ? push(false, dir) : false; }
export async function runSync(ctx: Ctx | undefined, options: { auto: boolean; push: boolean; skipPull?: boolean }, deps?: Deps) { const dir = dirOf(deps); if (!(await isSyncableRepo(dir))) { if (!options.auto) notify(ctx, `git-sync: no git repo with an 'origin' remote in ${dir}. Run /gitsync init.`, "warning", deps); return; } if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, "syncing"); try { await prepareCommit(deps, ctx); const tracked = await trackedSecretFiles(dir); if (tracked.length) notify(ctx, `git-sync: tracked sensitive files: ${tracked.join(", ")}. Remove with git rm --cached <file>.`, "warning", deps); const changed: string[] = []; if (await commitLocalChanges(deps, undefined, ctx)) changed.push("committed local changes"); for (const line of gapMessages(await syncGaps(dir, await readConfig(deps, ctx)))) warnOnce(ctx, `git-sync: ${line}`, deps, `${dir}|${line}`); if (!options.skipPull) { if (!(await fetchOrigin(dir))) { if (!options.auto) notify(ctx, "git-sync: fetch failed; skipped pull/push.", "warning", deps); return; } const upstream = await upstreamRef(dir); if (upstream && (await counts(upstream, dir)).behind > 0) { const result = await integrate(upstream, dir); changed.push("pulled updates"); if (await normalizeSettings(deps, ctx)) changed.push("normalized settings.json"); if (result.resolved.length) notify(ctx, resolvedMessage(result), "warning", deps); } } if (options.push) { const upstream = await upstreamRef(dir); if (!upstream || (await counts(upstream, dir)).ahead > 0) { if (await push(!upstream, dir)) changed.push("pushed"); } } if (changed.some(x => x.startsWith("pulled"))) notify(ctx, `git-sync: ${changed.join(", ")}. Run /reload to apply pulled config.`, "info", deps); else if (!options.auto) notify(ctx, changed.length ? `git-sync: ${changed.join(", ")}.` : "git-sync: already up to date.", "info", deps); } finally { if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined); } }

export function parseRepoReference(input: string, fallbackOwner: string) { const raw = input.trim().replace(/\.git$/i, ""); if (!raw) return undefined; const ssh = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i); if (ssh) return { owner: ssh[1]!, name: ssh[2]! }; try { const url = new URL(raw); if (["github.com", "www.github.com"].includes(url.hostname) && url.pathname.split("/").filter(Boolean).length === 2) { const [owner, name] = url.pathname.split("/").filter(Boolean); return { owner: owner!, name: name!.replace(/\.git$/i, "") }; } } catch {} const bits = raw.split("/").filter(Boolean); if (bits.length === 1) return { owner: fallbackOwner, name: bits[0]! }; if (bits.length === 2 && !raw.includes(":")) return { owner: bits[0]!, name: bits[1]! }; return undefined; }
function remoteFromArg(arg: string, fallback: string) { if (/^(https?|ssh):\/\//.test(arg) || /^git@/.test(arg) || arg.startsWith("/") || arg.startsWith(".")) return arg; const ref = parseRepoReference(arg, fallback); return ref ? `https://github.com/${ref.owner}/${ref.name}.git` : undefined; }
const defaultGh: GhClient = { async available() { try { await exec("gh", ["auth", "status"], { timeout: 5000 }); return true; } catch { return false; } }, async currentUser() { return (await exec("gh", ["api", "user", "--jq", ".login"])).stdout.trim(); }, async repoExists(id) { try { await exec("gh", ["repo", "view", id, "--json", "name"]); return true; } catch { return false; } }, async isPrivate(id) { try { const { stdout } = await exec("gh", ["repo", "view", id, "--json", "isPrivate"]); return (JSON.parse(stdout) as { isPrivate: boolean }).isPrivate; } catch { return undefined; } }, async createPrivateRepo(id) { await exec("gh", ["repo", "create", id, "--private"], { timeout: 15_000 }); }, remoteUrl(id) { return `https://github.com/${id}.git`; } };
async function addRemote(url: string, dir: string) { await git(["remote", "add", "origin", url], dir); }
async function hasOrigin(dir: string) { return isSyncableRepo(dir); }
async function initRepo(dir: string) { if (!(await hasDotGit(dir))) await git(["init", "-b", "main"], dir); }
async function warnPublic(ctx: Ctx | undefined, deps?: Deps) { const dir = dirOf(deps), config = await readConfig(deps, ctx); if (config.warnOnPublicRemote === false) return; const gh = deps?.gh ?? defaultGh; if (!(await gh.available())) return; try { const remote = (await git(["remote", "get-url", "origin"], dir)).stdout.trim(); const ref = parseRepoReference(remote, ""); if (ref && await gh.isPrivate(`${ref.owner}/${ref.name}`) === false) notify(ctx, "git-sync: remote is PUBLIC — pi-config-sync never syncs secrets, but review what you allowlist; silence with warnOnPublicRemote: false in git-sync.jsonc", "warning", deps); } catch {} }
export async function runInit(arg: string, ctx?: Ctx, deps?: Deps) { const dir = dirOf(deps); await fs.mkdir(dir, { recursive: true }); if (await hasOrigin(dir)) throw new Error("already initialized; use /gitsync sync"); const config = await readConfig(deps, ctx); await ensureIgnoreRules(dir, config); await initRepo(dir); await ensureInfoExclude(dir); const tracked = await trackedSecretFiles(dir); if (tracked.length) throw new Error(`tracked sensitive files: ${tracked.join(", ")}. Remove with git rm --cached <file>.`); await commitLocalChanges(deps, "pi config: initial sync setup", ctx); let remote = remoteFromArg(arg, ""); if (!remote) { const gh = deps?.gh ?? defaultGh; if (!(await gh.available())) { notify(ctx, "git-sync: initial commit created. Create a private repo, then run /gitsync init <url>.", "warning", deps); return; } const owner = await gh.currentUser(); const ref = parseRepoReference(arg || "pi-agent-config", owner); if (!ref) throw new Error(`invalid repository reference: ${arg}`); const id = `${ref.owner}/${ref.name}`; if (await gh.repoExists(id)) throw new Error("repository already exists; use /gitsync link instead"); await gh.createPrivateRepo(id); remote = gh.remoteUrl(id); } await addRemote(remote, dir); if (!(await push(true, dir))) throw new Error("initial push failed"); await warnPublic(ctx, deps); notify(ctx, "git-sync: initialized and pushed private config repo.", "info", deps); }
async function defaultBranch(dir: string) { try { const { stdout } = await git(["ls-remote", "--symref", "origin", "HEAD"], dir); const found = stdout.match(/ref: refs\/heads\/([^\s]+)\s+HEAD/); return found?.[1] ?? "main"; } catch { return "main"; } }
async function backupConflicts(dir: string, branch: string) { const { stdout } = await git(["ls-tree", "-r", "--name-only", "-z", `origin/${branch}`], dir); const backups: string[] = []; for (const relative of stdout.split("\0").filter(Boolean)) { const target = path.join(dir, relative); try { await fs.lstat(target); } catch { continue; } const local = await fs.readFile(target).catch(() => undefined); const remote = await gitRaw(["show", `origin/${branch}:${relative}`], dir).then(x => x.stdout).catch(() => undefined); if (local && remote && !local.equals(remote)) { await fs.rename(target, `${target}.local-backup`); backups.push(relative); } } return backups; }
export async function runLink(arg: string, ctx?: Ctx, deps?: Deps) { const dir = dirOf(deps); if (await hasOrigin(dir)) throw new Error("already linked; use /gitsync sync"); const gh = deps?.gh ?? defaultGh; let remote = remoteFromArg(arg, ""); if (!remote) { if (!(await gh.available())) { notify(ctx, "git-sync: provide a repo URL, or install and authenticate gh.", "warning", deps); return; } const owner = await gh.currentUser(); for (const name of LIKELY_SYNC_REPO_NAMES) if (await gh.repoExists(`${owner}/${name}`)) { remote = gh.remoteUrl(`${owner}/${name}`); break; } if (!remote) throw new Error("no sync repository found; provide its URL"); } await fs.mkdir(dir, { recursive: true }); if ((await hasDotGit(dir)) && (await hasCommits(dir))) throw new Error(`existing git history in ${dir} has no 'origin' remote; push or back it up (or remove ${path.join(dir, ".git")}) before linking`); const config = await readConfig(deps, ctx); await initRepo(dir); await ensureIgnoreRules(dir, config); await ensureInfoExclude(dir); await ensureAttributes(dir); await ensureFilter(dir, config, ctx, deps); await refreshMachineSidecar(dir, config); await addRemote(remote, dir); await git(["fetch", "origin"], dir); const branch = await defaultBranch(dir); const backups = await backupConflicts(dir, branch); try { await git(["checkout", "-B", branch, `origin/${branch}`], dir); } catch (error) { const output = message(error); const refused = output.match(/would be overwritten by checkout:\n([\s\S]*?)Please move or remove/)?.[1]?.split("\n").map(line => line.trim()).filter(Boolean) ?? []; for (const relative of refused) { if (isDenied(relative)) continue; const target = path.join(dir, relative); try { await fs.rename(target, `${target}.local-backup`); backups.push(relative); } catch {} } if (refused.length) { try { await git(["checkout", "-B", branch, `origin/${branch}`], dir); } catch (retry) { throw new Error(`${message(retry)}\nResolve manually in ${dir}`); } } else throw new Error(`${output}\nResolve manually in ${dir}`); } const tracked = await trackedSecretFiles(dir); if (tracked.length) notify(ctx, `git-sync: remote tracks sensitive files: ${tracked.join(", ")}. Remove with git rm --cached <file>.`, "warning", deps); await warnPublic(ctx, deps); notify(ctx, `git-sync: linked — run /reload to apply pulled config.${backups.length ? ` Backed up: ${backups.join(", ")}.` : ""}`, "info", deps); }
async function showStatus(ctx: ExtensionCommandContext, deps?: Deps) { const dir = dirOf(deps); if (!(await isSyncableRepo(dir))) { notify(ctx, `git-sync: ${dir} is not initialized. Run /gitsync init.`, "warning", deps); return; } const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).stdout.trim(); const dirty = (await git(["status", "--porcelain"], dir)).stdout.trim(); const bad = await trackedSecretFiles(dir), gaps = gapMessages(await syncGaps(dir, await readConfig(deps, ctx))); notify(ctx, `repo: ${dir}\nbranch: ${branch}\nuncommitted changes: ${dirty ? "yes" : "none"}${bad.length ? `\nWARNING tracked sensitive files: ${bad.join(", ")}` : ""}${gaps.map(line => `\nWARNING ${line}`).join("")}`, bad.length || gaps.length ? "warning" : "info", deps); await warnPublic(ctx, deps); }
async function readState(dir: string) { try { return JSON.parse(await fs.readFile(statePath(dir), "utf8")) as { lastAutoSyncAt?: string }; } catch { return {}; } }
async function writeState(state: { lastAutoSyncAt: string }, dir = dirOf()) { await fs.mkdir(stateDir(dir), { recursive: true }); await fs.writeFile(statePath(dir), JSON.stringify(state)); }
export async function shouldAutoSync(deps?: Deps) { const dir = dirOf(deps); if (isSubagentChild() || !(await isSyncableRepo(dir))) return false; const state = await readState(dir); if (!state.lastAutoSyncAt) return true; const config = await readConfig(deps); return Date.now() - Date.parse(state.lastAutoSyncAt) >= (config.autoSyncIntervalMinutes ?? 5) * 60_000; }
export async function withLock<T>(ctx: Ctx | undefined, fn: () => Promise<T>, deps?: Deps): Promise<T | undefined> { const dir = dirOf(deps); await fs.mkdir(stateDir(dir), { recursive: true }); try { const handle = await fs.open(lockPath(dir), "wx"); await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await handle.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; try { const lock = JSON.parse(await fs.readFile(lockPath(dir), "utf8")) as { pid: number; startedAt: string }; if (Number.isInteger(lock.pid) && lock.pid > 0) { process.kill(lock.pid, 0); if (Date.now() - Date.parse(lock.startedAt) < 600_000) return undefined; } } catch {} await fs.rm(lockPath(dir), { force: true }); return withLock(ctx, fn, deps); } try { return await fn(); } finally { await fs.rm(lockPath(dir), { force: true }); } }
