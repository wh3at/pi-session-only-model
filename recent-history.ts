import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { modelReferenceKey, type ModelReference } from "./command.ts";

const HISTORY_FILENAME = "recent-session-models.json";
const HISTORY_LIMIT = 5;

/**
 * Resolve the directory that holds the global recent-model history.
 *
 * Defaults to the agent's shared directory so the history is available across
 * every project and session for the same user and survives Pi restarts. Tests
 * override it with `PI_SESSION_ONLY_MODEL_HISTORY_DIR` to keep each fixture
 * isolated without touching the real agent directory.
 */
function historyDir(): string {
	return process.env.PI_SESSION_ONLY_MODEL_HISTORY_DIR || getAgentDir();
}

function historyPath(): string {
	return join(historyDir(), HISTORY_FILENAME);
}

/**
 * Read the most-recently-used model list. Missing or corrupt storage returns an
 * empty list so a failed read never blocks the picker.
 */
export function loadHistory(): ModelReference[] {
	try {
		const raw = readFileSync(historyPath(), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(model): model is ModelReference =>
				model != null &&
				typeof (model as ModelReference).provider === "string" &&
				typeof (model as ModelReference).id === "string",
		);
	} catch {
		return [];
	}
}

/**
 * Move `model` to the front of the most-recently-used list, dropping duplicates
 * and keeping only the five most recent. Writes atomically via a temp file and
 * rename so a crash mid-write cannot leave a corrupt history file.
 */
export function recordHistory(model: Pick<ModelReference, "provider" | "id">): void {
	const reference: ModelReference = { provider: model.provider, id: model.id };
	const key = modelReferenceKey(reference);
	const history = loadHistory().filter((recent) => modelReferenceKey(recent) !== key);
	history.unshift(reference);
	const trimmed = history.slice(0, HISTORY_LIMIT);
	const path = historyPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = join(dirname(path), `.${HISTORY_FILENAME}.${randomUUID()}.tmp`);
	writeFileSync(tmpPath, JSON.stringify(trimmed));
	renameSync(tmpPath, path);
}
