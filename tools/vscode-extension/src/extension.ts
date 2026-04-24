/**
 * SOA-Harness VS Code extension — v1.2 stub per L-63 scope.
 *
 * Reads workspace .soa/config.json for Runner URL + session bearer (falling
 * back to user settings), renders Runner status in the Explorer sidebar as a
 * TreeDataProvider, and registers two commands: "dispatch from editor"
 * (prompts for a one-shot dispatch against the editor's selected text) and
 * "tail audit log" (streams /audit/tail into a terminal).
 *
 * Deliberately minimal — no language-server features, no per-file Runner
 * status decorations, no workspace multi-root handling. M9+ work.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

interface SoaConfig {
  runnerUrl: string;
  sessionBearer: string;
}

function readWorkspaceConfig(): Partial<SoaConfig> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return {};
  const configPath = path.join(folders[0]!.uri.fsPath, ".soa", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw) as Partial<SoaConfig>;
  } catch {
    return {};
  }
}

function resolveConfig(): SoaConfig {
  const fromWorkspace = readWorkspaceConfig();
  const userSettings = vscode.workspace.getConfiguration("soaHarness");
  return {
    runnerUrl:
      fromWorkspace.runnerUrl ??
      (userSettings.get<string>("runnerUrl") || "http://127.0.0.1:7700"),
    sessionBearer:
      fromWorkspace.sessionBearer ?? (userSettings.get<string>("sessionBearer") || ""),
  };
}

class RunnerStatusTreeProvider implements vscode.TreeDataProvider<RunnerStatusItem> {
  private readonly _onDidChange = new vscode.EventEmitter<RunnerStatusItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private cachedStatus: RunnerStatusItem[] = [
    new RunnerStatusItem("Loading…", "Probing Runner", vscode.TreeItemCollapsibleState.None),
  ];

  refresh(): void {
    this._onDidChange.fire(undefined);
    this.probeRunner().catch(() => undefined);
  }

  private async probeRunner(): Promise<void> {
    const cfg = resolveConfig();
    const items: RunnerStatusItem[] = [];
    const headers: Record<string, string> = {};
    if (cfg.sessionBearer) headers["Authorization"] = `Bearer ${cfg.sessionBearer}`;
    items.push(new RunnerStatusItem("Runner", cfg.runnerUrl, vscode.TreeItemCollapsibleState.None));
    try {
      const healthRes = await fetch(`${cfg.runnerUrl}/health`);
      const h = (await healthRes.json()) as { status?: string; soaHarnessVersion?: string };
      items.push(
        new RunnerStatusItem(
          `Health: ${h.status ?? "?"}`,
          `spec ${h.soaHarnessVersion ?? "?"}`,
          vscode.TreeItemCollapsibleState.None,
        ),
      );
    } catch (err) {
      items.push(
        new RunnerStatusItem(
          "Health: unreachable",
          (err as Error).message,
          vscode.TreeItemCollapsibleState.None,
        ),
      );
    }
    try {
      const readyRes = await fetch(`${cfg.runnerUrl}/ready`, { headers });
      const r = (await readyRes.json()) as { status?: string };
      items.push(
        new RunnerStatusItem(
          `Ready: ${r.status ?? "?"}`,
          "",
          vscode.TreeItemCollapsibleState.None,
        ),
      );
    } catch (err) {
      items.push(
        new RunnerStatusItem(
          "Ready: error",
          (err as Error).message,
          vscode.TreeItemCollapsibleState.None,
        ),
      );
    }
    try {
      const vRes = await fetch(`${cfg.runnerUrl}/version`, { headers });
      const v = (await vRes.json()) as { runner_version?: string; spec_commit_sha?: string };
      items.push(
        new RunnerStatusItem(
          `runner_version: ${v.runner_version ?? "?"}`,
          v.spec_commit_sha ? `spec ${v.spec_commit_sha.slice(0, 12)}` : "",
          vscode.TreeItemCollapsibleState.None,
        ),
      );
    } catch (err) {
      items.push(
        new RunnerStatusItem(
          "Version: error",
          (err as Error).message,
          vscode.TreeItemCollapsibleState.None,
        ),
      );
    }
    this.cachedStatus = items;
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: RunnerStatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<RunnerStatusItem[]> {
    return Promise.resolve(this.cachedStatus);
  }
}

class RunnerStatusItem extends vscode.TreeItem {
  constructor(label: string, description: string, state: vscode.TreeItemCollapsibleState) {
    super(label, state);
    this.description = description;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const tree = new RunnerStatusTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("soaHarness.runnerStatus", tree),
  );

  // Kick off the first probe + set up auto-refresh
  tree.refresh();
  const auto = vscode.workspace.getConfiguration("soaHarness").get<number>("autoRefreshMs", 5000);
  if (auto > 0) {
    const handle = setInterval(() => tree.refresh(), auto);
    context.subscriptions.push({ dispose: () => clearInterval(handle) });
  }

  // soaHarness.refreshStatus — manual refresh from the tree-view title bar
  context.subscriptions.push(
    vscode.commands.registerCommand("soaHarness.refreshStatus", () => tree.refresh()),
  );

  // soaHarness.dispatch — prompt for text, fire a one-shot dispatch, show
  // result in a scratch editor. Minimal: sync mode (stream:false) to keep
  // the UX simple for v1.2; the streaming-into-editor experience can land
  // in a v1.2.x patch once the adoption signal is clear.
  context.subscriptions.push(
    vscode.commands.registerCommand("soaHarness.dispatch", async () => {
      const cfg = resolveConfig();
      if (!cfg.sessionBearer) {
        const openSettings = "Open settings";
        const choice = await vscode.window.showErrorMessage(
          "SOA-Harness: no session bearer configured. Set soaHarness.sessionBearer in settings or .soa/config.json.",
          openSettings,
        );
        if (choice === openSettings) {
          await vscode.commands.executeCommand("workbench.action.openSettings", "soaHarness");
        }
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const selected = editor?.document.getText(editor.selection);
      const prompt = await vscode.window.showInputBox({
        prompt: "Prompt for the Runner",
        value: selected ?? "",
        placeHolder: "e.g. 'summarize this file'",
      });
      if (!prompt) return;

      const turnId = "trn_" + Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20);
      const corId = "cor_" + Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20);
      const idem = "idem_" + Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20);
      const sessionId =
        (await vscode.window.showInputBox({
          prompt: "Session ID (ses_…) for this dispatch",
          placeHolder: "ses_XXXXXXXXXXXXXXXXXXXX",
        })) ?? "";
      if (!sessionId) return;

      try {
        const res = await fetch(`${cfg.runnerUrl}/dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.sessionBearer}`,
          },
          body: JSON.stringify({
            session_id: sessionId,
            turn_id: turnId,
            model: "example-adapter-model-id",
            messages: [{ role: "user", content: prompt }],
            budget_ceiling_tokens: 10_000,
            billing_tag: "tenant-vscode/env-dev",
            correlation_id: corId,
            idempotency_key: idem,
            stream: false,
          }),
        });
        const body = await res.text();
        const doc = await vscode.workspace.openTextDocument({
          content: `// soa dispatch result (HTTP ${res.status})\n${body}`,
          language: "json",
        });
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        vscode.window.showErrorMessage(`SOA-Harness dispatch failed: ${(err as Error).message}`);
      }
    }),
  );

  // soaHarness.tailAudit — open a terminal that runs `soa audit tail`
  // (requires @soa-harness/cli globally installed).
  context.subscriptions.push(
    vscode.commands.registerCommand("soaHarness.tailAudit", () => {
      const cfg = resolveConfig();
      const term = vscode.window.createTerminal({
        name: "SOA audit tail",
        env: {
          SOA_RUNNER_URL: cfg.runnerUrl,
          ...(cfg.sessionBearer ? { SOA_SESSION_BEARER: cfg.sessionBearer } : {}),
        },
      });
      term.sendText("soa audit tail");
      term.show();
    }),
  );
}

export function deactivate(): void {
  // nothing to clean up explicitly; context.subscriptions disposed by VS Code
}
