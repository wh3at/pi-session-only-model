import assert from "node:assert/strict";
import test from "node:test";
import {
	acquireGuard,
	deactivateLegacyGuard,
	isVersionSupported,
	readLatestRestorePolicy,
	SESSION_MODEL_MARKER_TYPE,
} from "../guard.ts";

function marker(suppressRestore: boolean) {
	return {
		type: "custom",
		customType: SESSION_MODEL_MARKER_TYPE,
		data: { schemaVersion: 1, suppressRestore, source: suppressRestore ? "session-only-model" : "standard-model" },
	};
}

function makeClasses() {
	class FakeSettingsManager {
		writes: string[] = [];
		setDefaultProvider(provider: string): void { this.writes.push(`provider:${provider}`); }
		setDefaultModel(model: string): void { this.writes.push(`model:${model}`); }
		setDefaultModelAndProvider(provider: string, model: string): void { this.writes.push(`pair:${provider}/${model}`); }
		setDefaultThinkingLevel(level: string): void { this.writes.push(`thinking:${level}`); }
	}

	class FakeSessionManager {
		entries: Array<Record<string, unknown>> = [
			{ type: "message", id: "a1", message: { role: "assistant", provider: "temp", model: "temp-model" } },
			{ type: "model_change", id: "m1", provider: "temp", modelId: "temp-model" },
			{ type: "thinking_level_change", id: "t1", thinkingLevel: "high" },
		];
		getLeafId(): string { return "a1"; }
		appendModelChange(provider: string, modelId: string): string {
			this.entries.push({ type: "model_change", id: "m2", provider, modelId });
			return "m2";
		}
		appendThinkingLevelChange(thinkingLevel: string): string {
			this.entries.push({ type: "thinking_level_change", id: "t2", thinkingLevel });
			return "t2";
		}
		getBranch(): Array<Record<string, unknown>> { return [...this.entries]; }
		buildSessionContext(): Record<string, unknown> {
			return {
				messages: [{ role: "assistant", provider: "temp", model: "temp-model" }],
				model: { provider: "temp", modelId: "temp-model" },
				thinkingLevel: "high",
			};
		}
	}
	return { FakeSettingsManager, FakeSessionManager };
}

function acquire(
	SettingsManager: ReturnType<typeof makeClasses>["FakeSettingsManager"],
	SessionManager: ReturnType<typeof makeClasses>["FakeSessionManager"],
	host: object = {},
) {
	return acquireGuard(
		{ SettingsManager, SessionManager },
		{
			version: "0.80.10",
			minimumVersion: "0.80.10",
			maximumVersionExclusive: "0.81.0",
			stateHost: host,
			stateKey: Symbol("test-state"),
		},
	);
}

test("version range is minimum-inclusive and maximum-exclusive", () => {
	assert.equal(isVersionSupported("0.80.10", "0.80.10", "0.81.0"), true);
	assert.equal(isVersionSupported("0.80.99-dev.1", "0.80.10", "0.81.0"), true);
	assert.equal(isVersionSupported("0.80.9", "0.80.10", "0.81.0"), false);
	assert.equal(isVersionSupported("0.81.0", "0.80.10", "0.81.0"), false);
});

test("normal writes remain unchanged outside /session-only-model", () => {
	const { FakeSettingsManager, FakeSessionManager } = makeClasses();
	const lease = acquire(FakeSettingsManager, FakeSessionManager);
	assert.equal(lease.compatible, true);
	const settings = new FakeSettingsManager();
	const session = new FakeSessionManager();

	settings.setDefaultModelAndProvider("openrouter", "persistent");
	settings.setDefaultThinkingLevel("high");
	session.appendModelChange("openrouter", "persistent");
	session.appendThinkingLevelChange("high");

	assert.deepEqual(settings.writes, ["pair:openrouter/persistent", "thinking:high"]);
	assert.equal(session.entries.at(-2)?.type, "model_change");
	assert.equal(session.entries.at(-1)?.type, "thinking_level_change");
});

test("only the async /session-only-model context suppresses persistence", async () => {
	const { FakeSettingsManager, FakeSessionManager } = makeClasses();
	const lease = acquire(FakeSettingsManager, FakeSessionManager);
	const settings = new FakeSettingsManager();
	const session = new FakeSessionManager();
	const before = session.entries.length;

	await lease.runSessionOnly(async () => {
		await Promise.resolve();
		settings.setDefaultModelAndProvider("openrouter", "temporary");
		settings.setDefaultThinkingLevel("minimal");
		assert.equal(session.appendModelChange("openrouter", "temporary"), "a1");
		assert.equal(session.appendThinkingLevelChange("minimal"), "a1");
		assert.equal(lease.isSessionOnlyActive(), true);
	});

	assert.deepEqual(settings.writes, []);
	assert.equal(session.entries.length, before);
	assert.equal(lease.isSessionOnlyActive(), false);
});

test("a concurrent normal write is not blocked by another async context", async () => {
	const { FakeSettingsManager, FakeSessionManager } = makeClasses();
	const lease = acquire(FakeSettingsManager, FakeSessionManager);
	const settings = new FakeSettingsManager();
	let releaseScoped!: () => void;
	const gate = new Promise<void>((resolve) => { releaseScoped = resolve; });

	const scoped = lease.runSessionOnly(async () => {
		await gate;
		settings.setDefaultModel("temporary");
	});
	await Promise.resolve();
	settings.setDefaultModel("persistent");
	releaseScoped();
	await scoped;

	assert.deepEqual(settings.writes, ["model:persistent"]);
});

test("bootstrap restore suppression is selective and ends at session_start", () => {
	const { FakeSettingsManager, FakeSessionManager } = makeClasses();
	const lease = acquire(FakeSettingsManager, FakeSessionManager);
	const session = new FakeSessionManager();
	session.entries.push(marker(true));

	assert.deepEqual(session.buildSessionContext().model, null);
	assert.equal(session.buildSessionContext().thinkingLevel, "off");
	assert.deepEqual(session.getBranch().map((entry) => entry.type), ["message", "custom"]);

	lease.markSessionReady(session);
	assert.deepEqual(session.buildSessionContext().model, { provider: "temp", modelId: "temp-model" });
	assert.deepEqual(
		session.getBranch().map((entry) => entry.type),
		["message", "model_change", "thinking_level_change", "custom"],
	);
});

test("a later standard-model marker restores Pi's normal bootstrap behavior", () => {
	const { FakeSettingsManager, FakeSessionManager } = makeClasses();
	acquire(FakeSettingsManager, FakeSessionManager);
	const session = new FakeSessionManager();
	session.entries.push(marker(true), marker(false));
	assert.deepEqual(session.buildSessionContext().model, { provider: "temp", modelId: "temp-model" });
	assert.equal(session.getBranch().some((entry) => entry.type === "model_change"), true);
});

test("reads only the latest valid restore marker", () => {
	assert.equal(readLatestRestorePolicy([marker(true), marker(false)])?.suppressRestore, false);
	assert.equal(readLatestRestorePolicy([{ type: "custom", customType: SESSION_MODEL_MARKER_TYPE, data: {} }]), undefined);
});

test("deactivates the 0.1.x process-wide guard during hot upgrade", () => {
	const host = {} as Record<symbol, unknown>;
	const key = Symbol.for("pi-session-only-model.guard.v2");
	host[key] = { schemaVersion: 2, activeLeases: 1, pendingHandoffs: 1 };
	deactivateLegacyGuard(host);
	assert.deepEqual(host[key], { schemaVersion: 2, activeLeases: 0, pendingHandoffs: 0 });
});

test("unsupported Pi versions disable only this command guard", () => {
	const { FakeSettingsManager, FakeSessionManager } = makeClasses();
	const original = FakeSettingsManager.prototype.setDefaultModel;
	const lease = acquireGuard(
		{ SettingsManager: FakeSettingsManager, SessionManager: FakeSessionManager },
		{
			version: "0.81.0",
			minimumVersion: "0.80.10",
			maximumVersionExclusive: "0.81.0",
			stateHost: {},
			stateKey: Symbol("unsupported"),
		},
	);
	assert.equal(lease.compatible, false);
	assert.equal(FakeSettingsManager.prototype.setDefaultModel, original);
	const settings = new FakeSettingsManager();
	settings.setDefaultModel("normal");
	assert.deepEqual(settings.writes, ["model:normal"]);
});
