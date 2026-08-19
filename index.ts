import {
	SessionManager,
	SettingsManager,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	modelReferenceKey,
	parseSessionModelCommand,
	type ModelReference,
} from "./command.ts";
import {
	pickSessionModel,
	type SessionModelSelection,
} from "./picker.ts";
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
	recentModelsSessionId?: string;
	recentModels?: ModelReference[];
}

const EXTENSION_NAME = "pi-session-only-model";
const MINIMUM_PI_VERSION = "0.83.0";
const RUNTIME_STATE_KEY = Symbol.for("pi-session-only-model.runtime.v2");

const USAGE = [
	"Usage:",
	"  /session-only-model",
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

function rememberRecentModel(
	state: RuntimeState,
	sessionIdValue: string,
	model: Pick<ModelReference, "provider" | "id">,
): void {
	const recentModels = state.recentModelsSessionId === sessionIdValue ? state.recentModels ?? [] : [];
	const reference: ModelReference = { provider: model.provider, id: model.id };
	const key = modelReferenceKey(reference);
	if (recentModels[0] && modelReferenceKey(recentModels[0]) === key) return;

	state.recentModelsSessionId = sessionIdValue;
	state.recentModels = [
		reference,
		...recentModels.filter((recent) => modelReferenceKey(recent) !== key),
	];
}

function seedRecentModels(state: RuntimeState, ctx: ExtensionContext, id: string): void {
	const recentModels: ModelReference[] = [];
	const seen = new Set<string>();
	const add = (model: Pick<ModelReference, "provider" | "id">): void => {
		const reference: ModelReference = { provider: model.provider, id: model.id };
		const key = modelReferenceKey(reference);
		if (seen.has(key)) return;
		seen.add(key);
		recentModels.push(reference);
	};

	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "model_change") {
			add({ provider: entry.provider, id: entry.modelId });
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			add({ provider: entry.message.provider, id: entry.message.model });
		}
	}
	if (ctx.model) add(ctx.model);

	state.recentModelsSessionId = id;
	state.recentModels = recentModels;
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

function resolveModel(ctx: ExtensionContext, reference: ModelReference) {
	const direct = ctx.modelRegistry.find(reference.provider, reference.id);
	if (direct) return direct;
	const provider = reference.provider.toLowerCase();
	const id = reference.id.toLowerCase();
	return ctx.modelRegistry
		.getAll()
		.find((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id);
}

async function setSessionModel(
	state: RuntimeState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	lease: ReturnType<typeof acquireGuard>,
	selection: SessionModelSelection,
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

	try {
		await lease.runSessionOnly(async () => {
			if (!(await pi.setModel(selection.model))) {
				throw new Error(
					`No authentication is available for ${formatModel({ provider: selection.model.provider, id: selection.model.id })}`,
				);
			}
			if (selection.thinkingLevel !== "off") {
				pi.setThinkingLevel(selection.thinkingLevel);
			}
		});
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	rememberRecentModel(state, sessionId(ctx), selection.model);

	state.activeOverride = { sessionId: sessionId(ctx), baseline };
	state.restoreSuppressionSessionId = sessionId(ctx);
	appendRestorePolicy(pi, true, "session-only-model");
	ctx.ui.notify(
		`Session model is now ${formatModel(currentModel(ctx) ?? { provider: selection.model.provider, id: selection.model.id })} · thinking=${pi.getThinkingLevel()}. ` +
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
			allowUntestedVersion: process.env.PI_SESSION_ONLY_MODEL_ALLOW_UNTESTED === "1",
		},
	);
	let restoreFilterWarningShown = false;

	pi.on("session_start", (event, ctx) => {
		lease.markSessionReady(ctx.sessionManager as object);
		const id = sessionId(ctx);
		if (event.reason !== "reload") state.activeOverride = undefined;
		seedRecentModels(state, ctx, id);
		state.restoreSuppressionSessionId = latestRestorePolicy(ctx)?.suppressRestore ? id : undefined;
		if (lease.restoreFilterAssumed && !restoreFilterWarningShown) {
			restoreFilterWarningShown = true;
			ctx.ui.notify(
				`${EXTENSION_NAME}: could not confirm Pi's model_change/thinking_level_change entry types on Pi ${VERSION}; ` +
					"restore suppression may not take effect. Normal /model behavior is unchanged.",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", (event, ctx) => {
		lease.markSessionClosed(ctx.sessionManager as object);
		if (event.reason !== "reload") {
			const id = sessionId(ctx);
			if (state.activeOverride?.sessionId === id) state.activeOverride = undefined;
			if (state.restoreSuppressionSessionId === id) state.restoreSuppressionSessionId = undefined;
			if (state.recentModelsSessionId === id) {
				state.recentModelsSessionId = undefined;
				state.recentModels = undefined;
			}
		}
	});

	pi.on("model_select", (event, ctx) => {
		const id = sessionId(ctx);
		rememberRecentModel(state, id, event.model);
		if (lease.isSessionOnlyActive() || event.source === "restore") return;
		const hadSessionPolicy =
			state.activeOverride?.sessionId === id ||
			state.restoreSuppressionSessionId === id ||
			latestRestorePolicy(ctx)?.suppressRestore === true;
		state.activeOverride = state.activeOverride?.sessionId === id ? undefined : state.activeOverride;
		state.restoreSuppressionSessionId = state.restoreSuppressionSessionId === id ? undefined : state.restoreSuppressionSessionId;
		if (hadSessionPolicy) appendRestorePolicy(pi, false, "standard-model");
	});
	pi.on("session_tree", (_event, ctx) => {
		const id = sessionId(ctx);
		seedRecentModels(state, ctx, id);
		if (state.restoreSuppressionSessionId === id) {
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
			if (parsed.command.action === "unsupported") {
				ctx.ui.notify(
					"Direct model selection, thinking-only changes, and status are unsupported.\n\n" + USAGE,
					"warning",
				);
				return;
			}
			if (parsed.command.action === "reset") {
				await resetSessionModel(state, pi, ctx, lease);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Model picker is only available in TUI mode.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Stop the current response before changing the session model.", "warning");
				return;
			}
			const selection = await pickSessionModel({
				scopedModels: ctx.scopedModels,
				modelRegistry: ctx.modelRegistry,
				recentModels: state.recentModelsSessionId === sessionId(ctx) ? state.recentModels : undefined,
				ui: ctx.ui,
			});
			if (!selection) return;
			await setSessionModel(state, pi, ctx, lease, selection);
		},
	});
}
