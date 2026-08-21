import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { modelReferenceKey, type ModelReference } from "./command.ts";

const HISTORY_FILENAME = "recent-session-models.json";
const HISTORY_LIMIT = 5;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 1_000;
const STALE_LOCK_MS = 30_000;

function historyDir(): string {
	return process.env.PI_SESSION_ONLY_MODEL_HISTORY_DIR || getAgentDir();
}

function historyPath(): string {
	return join(historyDir(), HISTORY_FILENAME);
}

interface HistoryRead {
	history: ModelReference[];
	readable: boolean;
}

async function readHistory(): Promise<HistoryRead> {
	try {
		const parsed: unknown = JSON.parse(await readFile(historyPath(), "utf8"));
		if (!Array.isArray(parsed)) return { history: [], readable: false };
		return {
			history: parsed.filter(
				(model): model is ModelReference =>
					model != null &&
					typeof (model as ModelReference).provider === "string" &&
					typeof (model as ModelReference).id === "string",
			),
			readable: true,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { history: [], readable: true };
		}
		return { history: [], readable: false };
	}
}

export async function loadHistory(): Promise<ModelReference[]> {
	return (await readHistory()).history;
}

async function acquireHistoryLock(): Promise<() => Promise<void>> {
	const lockPath = `${historyPath()}.lock`;
	await mkdir(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;

	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			return async () => {
				await handle.close();
				await rm(lockPath, { force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS) {
					await rm(lockPath);
					continue;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error("Recent model history is busy; try again.");
			await delay(LOCK_RETRY_MS);
		}
	}
}

export async function recordHistory(model: Pick<ModelReference, "provider" | "id">): Promise<void> {
	const release = await acquireHistoryLock();
	try {
		const { history, readable } = await readHistory();
		if (!readable) throw new Error("Existing recent model history could not be read; it was left unchanged.");

		const reference: ModelReference = { provider: model.provider, id: model.id };
		const key = modelReferenceKey(reference);
		const trimmed = [
			reference,
			...history.filter((recent) => modelReferenceKey(recent) !== key),
		].slice(0, HISTORY_LIMIT);
		const path = historyPath();
		const tmpPath = join(dirname(path), `.${HISTORY_FILENAME}.${randomUUID()}.tmp`);
		await writeFile(tmpPath, JSON.stringify(trimmed));
		await rename(tmpPath, path);
	} finally {
		await release();
	}
}
