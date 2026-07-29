import {
	SessionManager,
	SettingsManager,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	parseSessionModelCommand,
	type ModelReference,
	type SessionThinkingLevel,
} from "./command.ts";
import {
	acquireGuard,
	readLatestRestorePolicy,
	SESSION_MODEL_MARKER_TYPE,
	type RestorePolicyMarker,
} from "./guard.ts";

type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface SessionBaseline {
	model?: ModelReference;
	thinkingLevel: PiThinkingLevel;
}

interface ActiveOverride {
	sessionId: string;
	baseline: SessionBaseline;
}

interface RuntimeState {
	schemaVersion: 2;
	activeOverride?: ActiveOverride;
	restoreSuppressionSessionId?: string;
}

const EXTENSION_NAME = "pi-session-only-model";
const STATUS_KEY = EXTENSION_NAME;
const MINIMUM_PI_VERSION = "0.80.10";
const MAXIMUM_PI_VERSION_EXCLUSIVE = "0.81.0";
const RUNTIME_STATE_KEY = Symbol.for("pi-session-only-model.runtime.v2");

const USAGE = [
	"Usage:",
	"  /session-only-model <provider>/<model-id>",
	"  /session-only-model <provider>/<model-id> --thinking <level>",
	"  /session-only-model --thinking <level>",
	"  /session-only-model status",
	"  /session-only-model reset",
].join("\n");

function getRuntimeState(): RuntimeState {
	const host = globalThis as Record<symbol, unknown>;
	const existing = host[RUNTIME_STATE_KEY];
	if (existing !== undefined) {
		const state = existing as Partial<RuntimeState>;
		if (state.schemaVersion !== 2) throw new Error("found incompatible runtime state");
		return state as RuntimeState;
	}
	const created: RuntimeState = { schemaVersion: 2 };
	host[RUNTIME_STATE_KEY] = created;
	return created;
}

function sessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function currentModel(ctx: ExtensionContext): ModelReference | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function formatModel(model: ModelReference | undefined): string {
	return model ? `${model.provider}/${model.id}` : "(none)";
}

function sameModel(a: ModelReference | undefined, b: ModelReference | undefined): boolean {
	return a?.provider === b?.provider && a?.id === b?.id;
}

function activeForSession(state: RuntimeState, ctx: ExtensionContext): ActiveOverride | undefined {
	return state.activeOverride?.sessionId === sessionId(ctx) ? state.activeOverride : undefined;
}

function latestRestorePolicy(ctx: ExtensionContext): RestorePolicyMarker | undefined {
	return readLatestRestorePolicy(ctx.sessionManager.getBranch());
}

function appendRestorePolicy(pi: ExtensionAPI, suppressRestore: boolean, source: RestorePolicyMarker["source"]): void {
	pi.appendEntry<RestorePolicyMarker>(SESSION_MODEL_MARKER_TYPE, {
		schemaVersion: 1,
		suppressRestore,
		source,
	});
}

function updateStatus(state: RuntimeState, pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = activeForSession(state, ctx);
	ctx.ui.setStatus(
		STATUS_KEY,
		active ? `session-only-model: ${formatModel(currentModel(ctx))} · thinking=${pi.getThinkingLevel()}` : undefined,
	);
}

function resolveModel(ctx: ExtensionContext, reference: ModelReference) {
	const direct = ctx.modelRegistry.find(reference.provider, reference.id);
	if (direct) return direct;
	const provider = reference.provider.toLowerCase();
	const id = reference.id.toLowerCase();
	return ctx.modelRegistry
		.getAll()
		.find((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id);
}

function showStatus(state: RuntimeState, pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = activeForSession(state, ctx);
	const restoreSuppressed = state.restoreSuppressionSessionId === sessionId(ctx);
	const lines = [`current: ${formatModel(currentModel(ctx))} · thinking=${pi.getThinkingLevel()}`];
	if (active) {
		lines.push(`baseline: ${formatModel(active.baseline.model)} · thinking=${active.baseline.thinkingLevel}`);
		lines.push("scope: current in-memory session only");
	} else {
		lines.push("session override: inactive");
	}
	lines.push(
		restoreSuppressed
			? "next session/startup: resolve from settings defaults"
			: "next session/startup: Pi standard restore behavior",
	);
	ctx.ui.notify(lines.join("\n"), "info");
}

async function setSessionModel(
	state: RuntimeState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	lease: ReturnType<typeof acquireGuard>,
	modelReference: ModelReference | undefined,
	thinkingLevel: SessionThinkingLevel | undefined,
): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Stop the current response before changing the session model.", "warning");
		return;
	}

	const existing = activeForSession(state, ctx);
	const baseline: SessionBaseline = existing?.baseline ?? {
		model: currentModel(ctx),
		thinkingLevel: pi.getThinkingLevel(),
	};

	const model = modelReference ? resolveModel(ctx, modelReference) : undefined;
	if (modelReference && !model) {
		ctx.ui.notify(`Model not found: ${formatModel(modelReference)}`, "error");
		return;
	}

	try {
		await lease.runSessionOnly(async () => {
			if (model) {
				const changed = await pi.setModel(model);
				if (!changed) throw new Error(`No authentication is available for ${formatModel(modelReference)}`);
			}
			if (thinkingLevel) pi.setThinkingLevel(thinkingLevel as PiThinkingLevel);
		});
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	state.activeOverride = { sessionId: sessionId(ctx), baseline };
	state.restoreSuppressionSessionId = sessionId(ctx);
	appendRestorePolicy(pi, true, "session-only-model");
	updateStatus(state, pi, ctx);
	ctx.ui.notify(
		`Session model is now ${formatModel(currentModel(ctx) ?? modelReference)} · thinking=${pi.getThinkingLevel()}. ` +
			"settings.json and normal /model behavior were left unchanged.",
		"info",
	);
}

async function resetSessionModel(
	state: RuntimeState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	lease: ReturnType<typeof acquireGuard>,
): Promise<void> {
	const active = activeForSession(state, ctx);
	if (!active) {
		ctx.ui.notify("No session-only model override is active.", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Stop the current response before resetting the session model.", "warning");
		return;
	}

	try {
		await lease.runSessionOnly(async () => {
			const now = currentModel(ctx);
			if (active.baseline.model && !sameModel(now, active.baseline.model)) {
				const baselineModel = resolveModel(ctx, active.baseline.model);
				if (!baselineModel) throw new Error(`Baseline model is no longer available: ${formatModel(active.baseline.model)}`);
				if (!(await pi.setModel(baselineModel))) {
					throw new Error(`No authentication is available for ${formatModel(active.baseline.model)}`);
				}
			} else if (!active.baseline.model && now) {
				throw new Error("This session started without a model, and Pi cannot clear a selected model at runtime.");
			}
			pi.setThinkingLevel(active.baseline.thinkingLevel);
		});
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	state.activeOverride = undefined;
	state.restoreSuppressionSessionId = sessionId(ctx);
	// Keep bootstrap suppression because the transcript may already contain an
	// assistant response generated by the temporary model.
	appendRestorePolicy(pi, true, "session-only-model");
	updateStatus(state, pi, ctx);
	ctx.ui.notify(
		`Restored ${formatModel(active.baseline.model)} · thinking=${active.baseline.thinkingLevel} in memory.`,
		"info",
	);
}

export default function sessionOnlyModel(pi: ExtensionAPI): void {
	const state = getRuntimeState();
	const lease = acquireGuard(
		{ SettingsManager, SessionManager },
		{
			version: VERSION,
			minimumVersion: MINIMUM_PI_VERSION,
			maximumVersionExclusive: MAXIMUM_PI_VERSION_EXCLUSIVE,
			allowUntestedVersion: process.env.PI_SESSION_ONLY_MODEL_ALLOW_UNTESTED === "1",
		},
	);

	pi.on("session_start", (event, ctx) => {
		lease.markSessionReady(ctx.sessionManager as object);
		const id = sessionId(ctx);
		if (event.reason !== "reload") state.activeOverride = undefined;
		state.restoreSuppressionSessionId = latestRestorePolicy(ctx)?.suppressRestore ? id : undefined;
		updateStatus(state, pi, ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		lease.markSessionClosed(ctx.sessionManager as object);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (event.reason !== "reload") {
			if (state.activeOverride?.sessionId === sessionId(ctx)) state.activeOverride = undefined;
			if (state.restoreSuppressionSessionId === sessionId(ctx)) state.restoreSuppressionSessionId = undefined;
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (lease.isSessionOnlyActive() || event.source === "restore") return;
		const id = sessionId(ctx);
		const hadSessionPolicy =
			state.activeOverride?.sessionId === id ||
			state.restoreSuppressionSessionId === id ||
			latestRestorePolicy(ctx)?.suppressRestore === true;
		state.activeOverride = state.activeOverride?.sessionId === id ? undefined : state.activeOverride;
		state.restoreSuppressionSessionId = state.restoreSuppressionSessionId === id ? undefined : state.restoreSuppressionSessionId;
		if (hadSessionPolicy) appendRestorePolicy(pi, false, "standard-model");
		updateStatus(state, pi, ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => updateStatus(state, pi, ctx));

	pi.on("session_tree", (_event, ctx) => {
		if (state.restoreSuppressionSessionId === sessionId(ctx)) {
			// Tree navigation can move to a branch before the previous marker.
			appendRestorePolicy(pi, true, "session-only-model");
		}
	});

	pi.registerCommand("session-only-model", {
		description: "Temporarily select a model without changing Pi defaults",
		handler: async (args, ctx) => {
			if (!lease.compatible) {
				ctx.ui.notify(
					`${EXTENSION_NAME} is disabled: ${lease.reason ?? "unsupported Pi internals"}. ` +
						"Normal /model behavior is unchanged.",
					"error",
				);
				return;
			}

			const parsed = parseSessionModelCommand(args);
			if (!parsed.command) {
				ctx.ui.notify(`${parsed.error ?? "Invalid command"}\n\n${USAGE}`, "warning");
				return;
			}
			if (parsed.command.action === "status") {
				showStatus(state, pi, ctx);
				return;
			}
			if (parsed.command.action === "reset") {
				await resetSessionModel(state, pi, ctx, lease);
				return;
			}
			await setSessionModel(
				state,
				pi,
				ctx,
				lease,
				parsed.command.model,
				parsed.command.thinkingLevel,
			);
		},
	});
}
