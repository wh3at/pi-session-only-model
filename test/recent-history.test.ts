import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("loadHistory returns an empty list when no history exists", async () => {
	assert.deepEqual(await loadHistory(), []);
});

test("recordHistory dedupes to the most recent entry and caps at five", async () => {
	await recordHistory({ provider: "test", id: "m1" });
	await recordHistory({ provider: "test", id: "m2" });
	await recordHistory({ provider: "test", id: "m1" });
	assert.deepEqual(await loadHistory(), [
		{ provider: "test", id: "m1" },
		{ provider: "test", id: "m2" },
	]);
	for (let index = 3; index <= 7; index++) {
		await recordHistory({ provider: "test", id: `m${index}` });
	}
	const history = await loadHistory();
	assert.equal(history.length, 5);
	assert.deepEqual(history[0], { provider: "test", id: "m7" });
	assert.deepEqual(history.at(-1), { provider: "test", id: "m3" });
});

test("recordHistory serializes concurrent updates", async () => {
	await Promise.all([
		recordHistory({ provider: "test", id: "m1" }),
		recordHistory({ provider: "test", id: "m2" }),
	]);
	const ids = (await loadHistory()).map((model) => model.id);
	assert.equal(ids.length, 2);
	assert.deepEqual(new Set(ids), new Set(["m1", "m2"]));
});

test("recordHistory survives a load/record round trip through storage", async () => {
	await recordHistory({ provider: "test", id: "m2" });
	assert.deepEqual(await loadHistory(), [{ provider: "test", id: "m2" }]);
});

test("a corrupt history remains unchanged", async () => {
	const path = join(historyDir, "recent-session-models.json");
	const corrupt = "{ not valid json";
	await writeFile(path, corrupt, "utf8");
	assert.deepEqual(await loadHistory(), []);
	await assert.rejects(recordHistory({ provider: "test", id: "m2" }), /left unchanged/);
	assert.equal(await readFile(path, "utf8"), corrupt);
});
