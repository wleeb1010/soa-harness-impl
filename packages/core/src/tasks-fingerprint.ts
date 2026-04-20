import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { jcsBytes } from "./jcs.js";
import { sha256Hex } from "./digest.js";

export interface TaskEntry {
  task_id: string;
  task_json_sha256: string;
  dockerfile_sha256: string;
  entrypoint_sha256: string;
}

export interface TasksFingerprint {
  entries: TaskEntry[];
  fingerprint: string;
}

export function computeTaskEntry(taskDir: string, taskId: string): TaskEntry | null {
  const taskJsonPath = join(taskDir, "task.json");
  if (!existsSync(taskJsonPath)) return null;

  const taskJson: unknown = JSON.parse(readFileSync(taskJsonPath, "utf8"));
  const taskJsonSha = sha256Hex(jcsBytes(taskJson));
  const dockerfileSha = sha256Hex(readFileSync(join(taskDir, "Dockerfile")));

  const entrypointPath = join(taskDir, "entrypoint.sh");
  const entrypointSha = existsSync(entrypointPath)
    ? sha256Hex(readFileSync(entrypointPath))
    : "absent";

  return {
    task_id: taskId,
    task_json_sha256: taskJsonSha,
    dockerfile_sha256: dockerfileSha,
    entrypoint_sha256: entrypointSha
  };
}

export function computeTasksFingerprint(tasksDir: string): TasksFingerprint {
  const entries: TaskEntry[] = [];
  for (const name of readdirSync(tasksDir).sort()) {
    const taskDir = join(tasksDir, name);
    if (!statSync(taskDir).isDirectory()) continue;
    const entry = computeTaskEntry(taskDir, name);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
  const outerCanonical = jcsBytes(entries);
  const fingerprint = `sha256:${sha256Hex(outerCanonical)}`;
  return { entries, fingerprint };
}
