import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

const ELIGIBLE_STATES: ReadonlySet<string> = new Set(["idle", "done"]);
const RESULT_START = "HERDR_DELEGATION_RESULT_BEGIN";
const RESULT_END = "HERDR_DELEGATION_RESULT_END";
const MAX_RESULT_CHARS = 40_000;

interface HerdrWorkspace {
  workspace_id: string;
  label?: string;
}

interface HerdrAgent {
  agent?: string;
  agent_status?: string;
  cwd?: string;
  name?: string;
  pane_id?: string;
  tab_id?: string;
  workspace_id?: string;
}

interface ReadyHerdrAgent extends HerdrAgent {
  agent_status: "idle" | "done";
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}

interface HerdrTab {
  label?: string;
  tab_id: string;
}

interface HerdrWorkspaceList {
  workspaces?: HerdrWorkspace[];
}

interface HerdrAgentList {
  agents?: HerdrAgent[];
}

interface HerdrTabList {
  tabs?: HerdrTab[];
}

interface HerdrPromptResult {
  agent?: {
    agent_status?: string;
  };
}

interface WorkspaceChoice {
  id: string;
  label: string;
  tabs: TabChoice[];
}

interface TabChoice {
  id: string;
  label: string;
  agents: ReadyHerdrAgent[];
}

interface HerdrDelegationDetails {
  workspace: string;
  tab: string;
  agent: string;
  task: string;
  status: string;
}

interface TargetDiscovery {
  workspaces: WorkspaceChoice[];
  sourceAgent?: HerdrAgent;
  sourceWorkspace?: HerdrWorkspace;
  sourceTab?: HerdrTab;
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function parseResult<T>(stdout: string, command: string): T {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not read Herdr ${command} response as JSON.`);
  }
  if (payload && typeof payload === "object" && "result" in payload) {
    return payload.result as T;
  }
  return payload as T;
}

async function herdrJson<T>(pi: ExtensionAPI, args: string[], timeout = 15_000): Promise<T> {
  const result = await pi.exec("herdr", args, { timeout });
  if (result.code !== 0) {
    const detail = clean(result.stderr || result.stdout).slice(0, 400);
    throw new Error(`herdr ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return parseResult<T>(result.stdout, args.join(" "));
}

async function discoverTargets(pi: ExtensionAPI): Promise<TargetDiscovery> {
  const [workspaceData, agentData] = await Promise.all([
    herdrJson<HerdrWorkspaceList>(pi, ["workspace", "list"]),
    herdrJson<HerdrAgentList>(pi, ["agent", "list"]),
  ]);
  const currentPaneId = process.env.HERDR_PANE_ID;
  const agents = (agentData.agents || []).filter((agent): agent is ReadyHerdrAgent =>
    Boolean(agent.pane_id && agent.workspace_id && agent.tab_id) &&
    agent.pane_id !== currentPaneId &&
    (agent.agent_status === "idle" || agent.agent_status === "done") &&
    ELIGIBLE_STATES.has(agent.agent_status),
  );
  const workspaceById = new Map((workspaceData.workspaces || []).map((workspace) => [workspace.workspace_id, workspace]));
  const sourceWorkspaceId = process.env.HERDR_WORKSPACE_ID;
  const sourceTabId = process.env.HERDR_TAB_ID;
  const workspaceIds = [...new Set([
    ...agents.map((agent) => agent.workspace_id),
    ...(sourceWorkspaceId ? [sourceWorkspaceId] : []),
  ])];
  const tabResults: Array<[string, HerdrTab[]]> = await Promise.all(workspaceIds.map(async (workspaceId): Promise<[string, HerdrTab[]]> => {
    try {
      const data = await herdrJson<HerdrTabList>(pi, ["tab", "list", "--workspace", workspaceId]);
      return [workspaceId, data.tabs || []];
    } catch {
      return [workspaceId, []];
    }
  }));
  const tabsByWorkspace = new Map<string, HerdrTab[]>(tabResults);

  const workspaces = workspaceIds.map((workspaceId) => {
    const workspace = workspaceById.get(workspaceId);
    const workspaceAgents = agents.filter((agent) => agent.workspace_id === workspaceId);
    const tabById = new Map((tabsByWorkspace.get(workspaceId) || []).map((tab) => [tab.tab_id, tab]));
    const tabIds = [...new Set(workspaceAgents.map((agent) => agent.tab_id))];
    return {
      id: workspaceId,
      label: clean(workspace?.label) || workspaceId,
      tabs: tabIds.map((tabId) => {
        const tab = tabById.get(tabId);
        return {
          id: tabId,
          label: clean(tab?.label) || tabId,
          agents: workspaceAgents.filter((agent) => agent.tab_id === tabId),
        };
      }),
    };
  }).filter((workspace) => workspace.tabs.some((tab) => tab.agents.length));
  return {
    workspaces,
    sourceAgent: agentData.agents?.find((agent) => agent.pane_id === currentPaneId),
    sourceWorkspace: sourceWorkspaceId ? workspaceById.get(sourceWorkspaceId) : undefined,
    sourceTab: sourceWorkspaceId && sourceTabId
      ? tabsByWorkspace.get(sourceWorkspaceId)?.find((tab) => tab.tab_id === sourceTabId)
      : undefined,
  };
}

function describeSource(ctx: ExtensionCommandContext, source: TargetDiscovery): string {
  const paneId = process.env.HERDR_PANE_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  const agentName = clean(source.sourceAgent?.name) || clean(source.sourceAgent?.agent) || "Pi agent";
  const lines = [
    "This task was delegated from another Herdr-managed Pi session. Your own transcript is a different conversation.",
    `- Source agent: ${agentName}${paneId ? ` (pane ${paneId})` : ""}`,
    `- Source workspace: ${clean(source.sourceWorkspace?.label) || workspaceId || "unknown"}${workspaceId ? ` (${workspaceId})` : ""}`,
    `- Source tab: ${clean(source.sourceTab?.label) || tabId || "unknown"}${tabId ? ` (${tabId})` : ""}`,
    `- Source working directory: ${ctx.cwd}`,
    ...(sessionId ? [`- Source Pi session ID: ${sessionId}`] : []),
    ...(sessionFile ? [`- Exact source Pi transcript file (JSONL): ${sessionFile}`] : []),
    ...(paneId ? [`- Read recent source conversation: \`herdr agent read ${paneId} --source recent-unwrapped --lines 160\``] : []),
    "Before acting, inspect the source pane's recent output for the context relevant to this task. If that does not contain enough history, consult the exact source session transcript above. Treat both as read-only context; do not assume your own session contains it.",
  ];
  return lines.join("\n");
}

function optionLabel(label: string, id: string, current: boolean): string {
  return `${label} · ${id}${current ? " · current" : ""}`;
}

function extractMarkedResult(output: string): string | undefined {
  const start = output.lastIndexOf(RESULT_START);
  if (start < 0) return undefined;
  const bodyStart = output.indexOf("\n", start + RESULT_START.length);
  const end = output.indexOf(RESULT_END, bodyStart < 0 ? start + RESULT_START.length : bodyStart + 1);
  if (end < 0) return undefined;
  return output.slice(bodyStart < 0 ? start + RESULT_START.length : bodyStart + 1, end)
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*│ ?/u, "").replace(/ ?│\s*$/u, ""))
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI): void {
  pi.registerMessageRenderer<HerdrDelegationDetails>("herdr-delegation-result", (message, { outputPad }, theme) => {
    const details = message.details;
    const heading = `↗ ${clean(details?.workspace)} / ${clean(details?.tab)} / ${clean(details?.agent)}`;
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", heading), outputPad, 0));
    box.addChild(new Markdown(content, outputPad, 0, getMarkdownTheme()));
    return box;
  });

  pi.registerCommand("herdr-delegate", {
    description: "Choose a ready Herdr workspace/tab/agent and delegate a task",
    handler: async (args, ctx) => {
      if (process.env.HERDR_ENV !== "1") {
        ctx.ui.notify("/herdr-delegate is available only inside a Herdr-managed Pi session.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/herdr-delegate needs an interactive selector; run it from Pi's TUI.", "warning");
        return;
      }

      try {
        const discovery = await discoverTargets(pi);
        const workspaces = discovery.workspaces;
        if (!workspaces.length) {
          ctx.ui.notify("No other idle or done Herdr agents are available to receive a task.", "warning");
          return;
        }

        const currentWorkspace = process.env.HERDR_WORKSPACE_ID;
        const workspaceOptions = workspaces.map((workspace) => optionLabel(
          `${workspace.label} (${workspace.tabs.reduce((count, tab) => count + tab.agents.length, 0)} agents)`,
          workspace.id,
          workspace.id === currentWorkspace,
        ));
        const selectedWorkspaceOption = await ctx.ui.select("Choose Herdr workspace", workspaceOptions);
        if (!selectedWorkspaceOption) return;
        const workspace = workspaces[workspaceOptions.indexOf(selectedWorkspaceOption)];
        if (!workspace) return;

        const currentTab = process.env.HERDR_TAB_ID;
        const tabOptions = workspace.tabs.map((tab) => optionLabel(
          `${tab.label} (${tab.agents.length} agent${tab.agents.length === 1 ? "" : "s"})`,
          tab.id,
          tab.id === currentTab,
        ));
        const selectedTabOption = await ctx.ui.select(`Choose tab in ${workspace.label}`, tabOptions);
        if (!selectedTabOption) return;
        const tab = workspace.tabs[tabOptions.indexOf(selectedTabOption)];
        if (!tab) return;

        const agentOptions = tab.agents.map((agent) => {
          const name = clean(agent.name) || `${clean(agent.agent) || "agent"} (${agent.pane_id})`;
          const cwd = clean(agent.cwd).split(/[\\/]/u).filter(Boolean).slice(-2).join("/");
          return `${name} · ${agent.agent_status}${cwd ? ` · ${cwd}` : ""} · ${agent.pane_id}`;
        });
        const selectedAgentOption = await ctx.ui.select(`Choose agent in ${tab.label}`, agentOptions);
        if (!selectedAgentOption) return;
        const agent = tab.agents[agentOptions.indexOf(selectedAgentOption)];
        if (!agent) return;

        const task = args.trim() || (await ctx.ui.input("What should the selected agent do?", "Describe the delegated task"))?.trim();
        if (!task) return;

        const agentName = clean(agent.name) || `${clean(agent.agent) || "agent"} (${agent.pane_id})`;
        const prompt = [
          "## Delegation source and context",
          describeSource(ctx, discovery),
          "",
          "## Task",
          task,
          "",
          "When finished, provide the user-facing deliverable and end your final response with these exact marker lines, with the complete deliverable between them:",
          RESULT_START,
          "(complete user-facing result)",
          RESULT_END,
          "Do not put analysis or internal reasoning inside the marked result block.",
        ].join("\n");
        const preview = prompt.length > 700 ? `${prompt.slice(0, 697)}…` : prompt;
        const accepted = await ctx.ui.confirm(
          `Delegate to ${workspace.label} / ${tab.label} / ${agentName}?`,
          `${preview}\n\nThis sends a prompt to that agent's existing conversation.`,
        );
        if (!accepted) return;

        ctx.ui.setWorkingMessage(`Delegating to ${agentName} in ${workspace.label} / ${tab.label}…`);
        try {
          const prompted = await pi.exec("herdr", [
            "agent", "prompt", agent.pane_id, prompt, "--wait", "--timeout", "600000",
          ], { timeout: 615_000 });
          if (prompted.code !== 0) {
            let observed = "unknown";
            try {
              const current = await herdrJson<{ agent?: { agent_status?: string } }>(pi, ["agent", "get", agent.pane_id]);
              observed = current.agent?.agent_status || observed;
              await pi.exec("herdr", ["agent", "read", agent.pane_id, "--source", "recent-unwrapped", "--lines", "120"], { timeout: 20_000 });
            } catch { /* Preserve the original prompt failure; never resubmit automatically. */ }
            const detail = clean(prompted.stderr || prompted.stdout).slice(0, 400);
            ctx.ui.notify(`Delegation did not settle cleanly (agent is ${observed}). I did not resend the task. Inspect ${workspace.label} / ${tab.label} / ${agentName}.${detail ? ` ${detail}` : ""}`, "warning");
            return;
          }

          const status = parseResult<HerdrPromptResult>(prompted.stdout, "agent prompt").agent?.agent_status || "settled";
          const read = await pi.exec("herdr", [
            "agent", "read", agent.pane_id, "--source", "recent-unwrapped", "--lines", "1200",
          ], { timeout: 30_000 });
          const reply = read.code === 0 ? extractMarkedResult(read.stdout) : undefined;
          if (!reply) {
            ctx.ui.notify(`Agent finished (${status}) in ${workspace.label} / ${tab.label}, but I couldn't isolate its marked final response. Open that tab to read it; I did not retry.`, "warning");
            return;
          }

          const content = reply.length > MAX_RESULT_CHARS
            ? `${reply.slice(0, MAX_RESULT_CHARS)}\n\n[Response truncated at ${MAX_RESULT_CHARS.toLocaleString()} characters.]`
            : reply;
          pi.sendMessage({
            customType: "herdr-delegation-result",
            content,
            display: true,
            details: {
              workspace: workspace.label,
              tab: tab.label,
              agent: agentName,
              task,
              status,
            },
          });
          ctx.ui.notify(`Delegation complete. The marked response from ${agentName} was added to this conversation.`, "info");
        } finally {
          ctx.ui.setWorkingMessage();
        }
      } catch (error) {
        ctx.ui.setWorkingMessage();
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
