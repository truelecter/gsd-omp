'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OMP_TOOLS = 'read, write, edit, bash, glob, grep, lsp, web_search, task';
const OMP_ORCHESTRATION = `
## OMP native orchestration

OMP's native task tool owns subagents, jobs, progress, cancellation, artifacts, and isolation. When a GSD workflow asks to spawn an Agent(...), dispatch a native task instead; never emulate a subagent with shell backgrounding or a hand-written worktree.

- Use native task's batch schema: shared top-level \`context\` plus \`tasks[]\`; each item needs a stable \`name\`, an \`agent\`, and a complete self-contained \`task\`. Executor work must set \`isolated: true\`.
- Use \`job poll\` only when blocked on a wave barrier. IRC is coordination, not task completion.
- Preserve GSD's commit, merge, verification, SUMMARY.md, and STATE.md gates. Native task execution does not bypass workflow safety.
`;

const OMP_EXECUTOR_PROTOCOL = `
## OMP executor result protocol

End the final report with exactly one lifecycle line, then follow OMP's terminal yield protocol:

\`\`\`text
[gsd-task-result] phase {PHASE} plan {PLAN} task {TASK_ID} completed
\`\`\`

Use \`failed\` or \`cancelled\` instead of \`completed\` when the plan did not complete.
`;

const EXECUTE_PHASE_SKILL = 'gsd-execute-phase';

// GSD Core's markdown trees under `gsd-core/`, which skills, agents, and workflows load by path.
// GSD Core's own installer copies them with `/gsd:<cmd>` normalized to `/gsd-<cmd>`; reading the
// package originals would show the agent the colon form, which no host registers. They are
// projected under the runtime root; `gsd-core/bin/` stays in the package and runs from there.
const CORE_DOC_DIRS = ['contexts', 'references', 'templates', 'workflows'];
const CORE_DOC_PATTERN = new RegExp(`(?:~|\\$HOME)/\\.claude/gsd-core/(${CORE_DOC_DIRS.join('|')})(?![a-zA-Z0-9_.-])`, 'g');

// Shared by the `/gsd-execute-phase` command prompt and the projected execute-phase skill, so
// every route into the workflow (the command, plan-phase auto-advance, autonomous, a skill read)
// carries the same OMP isolation rules.
function ompExecuteDispatchContract(phase) {
  return `OMP dispatch contract:
- This OMP contract takes precedence over runtime-specific \`Agent(...)\` or \`isolation="worktree"\` directions in execute-phase: on OMP, native \`task\` with \`isolated: true\` is the only valid isolated executor dispatch. OMP declares \`dispatch.isolation: "none"\` in its EoS handshake — GSD's isolation vocabulary is harness-created (Claude) or GSD-created (Codex) worktrees, neither of which applies; OMP's isolation is its native task \`isolated: true\` primitive, so always resolve the executor-isolation step to the native-task path below, never to \`harness-worktree\`/\`orchestrator-worktree\` dispatch, and never to inline main-checkout writes.
- GSD Core has no OMP runtime entry, so \`gsd-tools query dispatch-isolation\` resolves \`none\` and the execute-phase isolation gate prints \`FATAL: runtime 'omp' declares no executor-isolation primitive\`. That verdict does not apply on OMP: do not stop on it, and do not set \`workflow.use_worktrees=false\` to get past it. Skip the steps that manage GSD-created worktrees (\`worktree.reap-orphans\`, \`worktree.base-check\`, the wave worktree manifest, \`worktree.record-agent\`, \`worktree.cleanup-wave\`): OMP creates, merges back, and removes each isolated workspace itself.
- Use native \`task\` for every non-interactive executor dispatch. One plan is one task; independent plans in a wave are one task batch. Never use \`irc wait\` for task completion: IRC is coordination-only. Use \`job poll\` for the spawned native runtime IDs and consume every native task result before dispatching the next wave.
- For a wave, call native \`task\` with its batch shape: a shared top-level \`context\` and \`tasks[]\`. Each executor item has \`name: "Phase${phase}Plan{PLAN_COMPACT}Executor"\` (remove plan punctuation), \`agent: "gsd-executor"\`, the complete self-contained plan assignment in \`task\`, and \`isolated: true\`. Do not put \`agent\` at the top level and do not invent \`id\`, \`role\`, \`description\`, or \`assignment\` fields.
- Every executor that writes repository files MUST request \`isolated: true\`. If isolated execution is unavailable, stop and report the blocked plan; never fall back to main-checkout writes or manual \`git worktree\` commands.
- \`--interactive\` is the only sequential inline mode. All other executor work uses native task dispatch.
- Native task completion is not a completion gate. Reconcile its \`[gsd-task-result]\` line, then require the existing SUMMARY.md, commit, merge, post-wave verification, and STATE.md updates before marking the plan complete.
- When an isolated task reports \`merge-summary\` patches applied (\`task.isolation.merge: patch\`), treat those changes as an uncommitted handoff: inspect \`git status\` and the patch, run the required verification, then create the plan's required commit in the parent checkout. Never recreate child file edits by hand. When it reports its task branch merged (\`task.isolation.merge: branch\`), the executor's own commits are already on the parent branch: check them like any executor commits and do not commit the same changes again.
- After each reconciled plan, emit exactly \`[checkpoint] phase ${phase} wave {N}/{M} plan {PLAN} complete ({P}/{Q} plans done)\`, or the corresponding \`failed\` / \`checkpoint\` status.
- When OMP's native \`todo\` tool is available, track the run with it: before dispatching the first wave, \`init\` one phase with an item per wave (naming its plans) and one with the post-wave gates the workflow will run (for example code review, regression, verification, and phase completion). Start and finish items as the run moves; the \`[checkpoint]\` lines are status records and do not replace \`todo\`.
- Preserve GSD's no-duplicate-work, failure, merge, and verification rules. Apart from \`todo\`, do not invent a separate progress UI; OMP owns native job progress and cancellation.
`;
}

const EXECUTE_DISPATCH_BLOCK = `<omp_dispatch>\n${ompExecuteDispatchContract('{PHASE}')}</omp_dispatch>`;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandNames(coreRoot) {
  return fs.readdirSync(path.join(coreRoot, 'commands', 'gsd'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3))
    .sort();
}

function transformCommands(content, names) {
  if (!names.length) return content;
  const alternatives = [...names].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
  const pattern = new RegExp(`(?<![a-zA-Z0-9_-])gsd:(${alternatives})(?=[^a-zA-Z0-9_-]|$)`, 'g');
  return content.replace(pattern, (_match, name) => `gsd-${name}`);
}

function rewriteRuntimePaths(content, { coreRoot, runtimeRoot, names }) {
  const coreGsd = toPosix(path.join(coreRoot, 'gsd-core'));
  const ompRoot = toPosix(runtimeRoot);
  return transformCommands(
    content
      .replace(CORE_DOC_PATTERN, (_match, dir) => `${ompRoot}/gsd-core/${dir}`)
      .replace(/~\/\.claude\/gsd-core/g, () => coreGsd)
      .replace(/\$HOME\/\.claude\/gsd-core/g, () => coreGsd)
      .replace(/~\/\.claude\//g, () => `${ompRoot}/`)
      .replace(/\$HOME\/\.claude\//g, () => `${ompRoot}/`)
      .replace(/~\/\.claude\b/g, () => ompRoot)
      .replace(/\$HOME\/\.claude\b/g, () => ompRoot),
    names,
  );
}

function projectAgent(content, sourcePath, context) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Missing YAML frontmatter: ${sourcePath}`);
  const [, frontmatter, rawBody] = match;
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error(`Missing name or description: ${sourcePath}`);
  const body = rewriteRuntimePaths(rawBody, context);
  return [
    '---',
    `name: ${name}`,
    `description: ${rewriteRuntimePaths(description, context)}`,
    `tools: ${OMP_TOOLS}`,
    'spawns: "*"',
    '---',
    '',
    body,
    OMP_ORCHESTRATION,
    name === 'gsd-executor' ? OMP_EXECUTOR_PROTOCOL : '',
  ].filter((part) => part !== '').join('\n');
}

function runtimeCliBlock(coreRoot, runtimeRoot) {
  const cliPath = toPosix(path.join(coreRoot, 'gsd-core', 'bin', 'gsd-tools.cjs'));
  const agentsRoot = runtimeRoot ? toPosix(path.join(runtimeRoot, 'agents')) : '~/.omp/agent/agents';
  return `<omp_runtime_cli>\n**OMP runtime CLI:** \`${cliPath}\` is the authoritative GSD CLI for this plugin. Run it with \`GSD_RUNTIME=omp\`. OMP owns model routing, approvals, native tasks, and isolation.\n\n**Agents on OMP:** GSD's \`init.progress\`/\`init.new-project\` agent check (\`.planning/agents_installed\`) resolves the agents directory from the runtime home. OMP's global config dir is not a registered gsd-core runtime, so the check reports missing agents unless it is pointed at \`${agentsRoot}\`. Export \`GSD_AGENTS_DIR\` with that directory before running GSD; the workflow then sees the projected agents consistently.\n</omp_runtime_cli>`;
}

function projectSkill(name, content, context) {
  const rewritten = rewriteRuntimePaths(content, context);
  const blocks = [runtimeCliBlock(context.coreRoot, context.runtimeRoot)];
  if (name === EXECUTE_PHASE_SKILL) blocks.push(EXECUTE_DISPATCH_BLOCK);
  const missing = blocks.filter((block) => !rewritten.includes(block));
  if (!missing.length) return rewritten;
  const marker = ['<context>', '<process>', '<objective>'].find((candidate) => rewritten.includes(candidate));
  const frontmatterEnd = rewritten.indexOf('\n---\n', 3);
  const index = marker ? rewritten.indexOf(marker) : frontmatterEnd < 0 ? -1 : frontmatterEnd + 5;
  if (index < 0) throw new Error(`Missing insertion point in ${name}/SKILL.md`);
  return `${rewritten.slice(0, index)}${missing.join('\n\n')}\n\n${rewritten.slice(index)}`;
}

function listFiles(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) return listFiles(root, child);
      return entry.isFile() ? [child] : [];
    });
}

function projectCoreDocs(context) {
  const gsdCore = path.join(context.coreRoot, 'gsd-core');
  return CORE_DOC_DIRS.flatMap((dir) => {
    const dirRoot = path.join(gsdCore, dir);
    if (!fs.existsSync(dirRoot)) return [];
    return listFiles(dirRoot).map((file) => {
      const source = fs.readFileSync(path.join(dirRoot, file));
      return {
        relativePath: path.join('gsd-core', dir, file),
        content: file.endsWith('.md') ? rewriteRuntimePaths(source.toString('utf8'), context) : source,
      };
    });
  });
}

function buildProjectedArtifacts({ coreRoot, runtimeRoot }) {
  const names = commandNames(coreRoot);
  const context = { coreRoot, runtimeRoot, names };
  const artifacts = [];
  const agentsRoot = path.join(coreRoot, 'agents');
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    // OMP registers every agents/*.md as a task agent; a `.compact.md` variant shares its
    // base agent's `name` and would shadow it. gsd-core's own installer skips these via
    // hostBehaviors.skipCompactAgents for the same reason.
    if (!entry.isFile() || !/^gsd-.*\.md$/.test(entry.name) || entry.name.endsWith('.compact.md')) continue;
    const sourcePath = path.join(agentsRoot, entry.name);
    artifacts.push({
      relativePath: path.join('agents', entry.name),
      content: projectAgent(fs.readFileSync(sourcePath, 'utf8'), sourcePath, context),
    });
  }

  const skillsRoot = path.join(coreRoot, 'skills');
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('gsd-')) continue;
    const sourcePath = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(sourcePath)) continue;
    artifacts.push({
      relativePath: path.join('skills', entry.name, 'SKILL.md'),
      content: projectSkill(entry.name, fs.readFileSync(sourcePath, 'utf8'), context),
    });
  }
  artifacts.push(...projectCoreDocs(context));
  return artifacts;
}

module.exports = {
  buildProjectedArtifacts,
  commandNames,
  ompExecuteDispatchContract,
  projectAgent,
  projectSkill,
  rewriteRuntimePaths,
  transformCommands,
};
