import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHistory, recordHistory } from "../recent-history.ts";

let historyDir: string;

test.beforeEach(async () => {
	historyDir = await mkdtemp(join(tmpdir(), "pi-session-only-model-history-"));
	process.env.PI_SESSION_ONLY_MODEL_HISTORY_DIR = historyDir;
});

test.afterEach(async () => {
	delete process.env.PI_SESSION_ONLY_MODEL_HISTORY_DIR;
	await rm(historyDir, { recursive: true, force: true });
});

test("loadHistory returns an empty list when no history exists", () => {
	assert.deepEqual(loadHistory(), []);
});

test("recordHistory dedupes to the most recent entry and caps at five", () => {
	recordHistory({ provider: "test", id: "m1" });
	recordHistory({ provider: "test", id: "m2" });
	recordHistory({ provider: "test", id: "m1" });
	assert.deepEqual(loadHistory(), [
		{ provider: "test", id: "m1" },
		{ provider: "test", id: "m2" },
	]);
	for (let index = 3; index <= 7; index++) {
		recordHistory({ provider: "test", id: `m${index}` });
	}
	const history = loadHistory();
	assert.equal(history.length, 5);
	assert.deepEqual(history[0], { provider: "test", id: "m7" });
	assert.deepEqual(history.at(-1), { provider: "test", id: "m3" });
});

test("recordHistory survives a load/record round trip through storage", () => {
	recordHistory({ provider: "test", id: "m2" });
	assert.deepEqual(loadHistory(), [{ provider: "test", id: "m2" }]);
});

test("loadHistory returns an empty list when the file is corrupt", async () => {
	await writeFile(join(historyDir, "recent-session-models.json"), "{ not valid json", "utf8");
	assert.deepEqual(loadHistory(), []);
});
