import { AsyncLocalStorage } from "node:async_hooks";

export const SESSION_MODEL_MARKER_TYPE = "pi-session-only-model/restore-policy";

export interface RestorePolicyMarker {
	schemaVersion: 1;
	suppressRestore: boolean;
	source: "session-only-model" | "standard-model";
}

export interface PrototypeCarrier {
	prototype: object;
}

export interface GuardTargets {
	SettingsManager: PrototypeCarrier;
	SessionManager: PrototypeCarrier;
}

export interface GuardOptions {
	version: string;
	minimumVersion: string;
	maximumVersionExclusive: string;
	allowUntestedVersion?: boolean;
	stateHost?: object;
	stateKey?: symbol;
}

export interface GuardLease {
	readonly compatible: boolean;
	readonly reason?: string;
	markSessionReady(sessionManager: object): void;
	markSessionClosed(sessionManager: object): void;
	runSessionOnly<T>(operation: () => T): T;
	isSessionOnlyActive(): boolean;
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

interface SuppressionContext {
	suppressPersistence: true;
}

interface SharedGuardState {
	schemaVersion: 3;
	installed: boolean;
	readySessionManagers: WeakSet<object>;
	storage: AsyncLocalStorage<SuppressionContext>;
	settingsPrototype?: object;
	sessionPrototype?: object;
	originalGetBranch?: AnyMethod;
}

const DEFAULT_STATE_KEY = Symbol.for("pi-session-only-model.guard.v3");
const LEGACY_STATE_KEY = Symbol.for("pi-session-only-model.guard.v2");
const SUPPRESSION_CONTEXT: SuppressionContext = Object.freeze({ suppressPersistence: true });
const SUPPRESSED_ENTRY_ID = "__pi_session_only_model_noop__";

const SETTINGS_WRITES_TO_SUPPRESS = [
	"setDefaultProvider",
	"setDefaultModel",
	"setDefaultModelAndProvider",
	"setDefaultThinkingLevel",
] as const;

const SESSION_WRITES_TO_SUPPRESS = ["appendModelChange", "appendThinkingLevelChange"] as const;
const SESSION_BOOTSTRAP_METHODS = ["buildSessionContext", "getBranch"] as const;

function parseVersion(version: string): readonly [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < 3; index++) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) return delta < 0 ? -1 : 1;
	}
	return 0;
}

export function isVersionSupported(
	version: string,
	minimumVersion: string,
	maximumVersionExclusive: string,
): boolean {
	const parsed = parseVersion(version);
	const minimum = parseVersion(minimumVersion);
	const maximum = parseVersion(maximumVersionExclusive);
	if (!parsed || !minimum || !maximum) return false;
	return compareVersion(parsed, minimum) >= 0 && compareVersion(parsed, maximum) < 0;
}

function getState(host: object, key: symbol): SharedGuardState {
	const record = host as Record<symbol, unknown>;
	const existing = record[key];
	if (existing !== undefined) {
		const state = existing as Partial<SharedGuardState>;
		if (
			state.schemaVersion !== 3 ||
			typeof state.installed !== "boolean" ||
			!(state.readySessionManagers instanceof WeakSet) ||
			!(state.storage instanceof AsyncLocalStorage)
		) {
			throw new Error("found incompatible shared guard state");
		}
		return state as SharedGuardState;
	}

	const created: SharedGuardState = {
		schemaVersion: 3,
		installed: false,
		readySessionManagers: new WeakSet<object>(),
		storage: new AsyncLocalStorage<SuppressionContext>(),
	};
	record[key] = created;
	return created;
}

/**
 * Version 0.1.x installed process-wide wrappers that blocked every /model call.
 * Turning its shared counters off makes those wrappers pass through. The new
 * context-selective wrappers can then be installed safely around them.
 */
export function deactivateLegacyGuard(host: object = globalThis): void {
	const legacy = (host as Record<symbol, unknown>)[LEGACY_STATE_KEY];
	if (!legacy || typeof legacy !== "object") return;
	const state = legacy as { schemaVersion?: unknown; activeLeases?: unknown; pendingHandoffs?: unknown };
	if (state.schemaVersion !== 2) return;
	if (typeof state.activeLeases === "number") state.activeLeases = 0;
	if (typeof state.pendingHandoffs === "number") state.pendingHandoffs = 0;
}

function methodDescriptor(target: object, name: string): PropertyDescriptor {
	const descriptor = Object.getOwnPropertyDescriptor(target, name);
	if (!descriptor || typeof descriptor.value !== "function") {
		throw new Error(`required method ${name}() was not found`);
	}
	return descriptor;
}

function replaceMethod(target: object, name: string, createWrapper: (original: AnyMethod) => AnyMethod): AnyMethod {
	const descriptor = methodDescriptor(target, name);
	const original = descriptor.value as AnyMethod;
	Object.defineProperty(target, name, {
		...descriptor,
		value: createWrapper(original),
	});
	return original;
}

function suppressedAppendResult(receiver: unknown): string {
	if (typeof receiver === "object" && receiver !== null) {
		const getLeafId = (receiver as { getLeafId?: unknown }).getLeafId;
		if (typeof getLeafId === "function") {
			const leafId = Reflect.apply(getLeafId, receiver, []);
			if (typeof leafId === "string") return leafId;
		}
	}
	return SUPPRESSED_ENTRY_ID;
}

export function readLatestRestorePolicy(entries: readonly unknown[]): RestorePolicyMarker | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || record.customType !== SESSION_MODEL_MARKER_TYPE) continue;
		if (typeof record.data !== "object" || record.data === null) continue;
		const data = record.data as Partial<RestorePolicyMarker>;
		if (
			data.schemaVersion === 1 &&
			typeof data.suppressRestore === "boolean" &&
			(data.source === "session-only-model" || data.source === "standard-model")
		) {
			return data as RestorePolicyMarker;
		}
	}
	return undefined;
}

function shouldSuppressRestore(state: SharedGuardState, receiver: unknown, branch?: readonly unknown[]): boolean {
	if (typeof receiver !== "object" || receiver === null || state.readySessionManagers.has(receiver)) return false;
	let entries = branch;
	if (!entries) {
		if (!state.originalGetBranch) throw new Error("guard was installed without getBranch()");
		const result = Reflect.apply(state.originalGetBranch, receiver, []);
		if (!Array.isArray(result)) throw new Error("getBranch() returned an unsupported shape");
		entries = result;
	}
	return readLatestRestorePolicy(entries)?.suppressRestore === true;
}

function installPatches(state: SharedGuardState, targets: GuardTargets): void {
	const settingsPrototype = targets.SettingsManager.prototype;
	const sessionPrototype = targets.SessionManager.prototype;

	for (const method of SETTINGS_WRITES_TO_SUPPRESS) methodDescriptor(settingsPrototype, method);
	for (const method of SESSION_WRITES_TO_SUPPRESS) methodDescriptor(sessionPrototype, method);
	for (const method of SESSION_BOOTSTRAP_METHODS) methodDescriptor(sessionPrototype, method);

	if (state.installed) {
		if (state.settingsPrototype !== settingsPrototype || state.sessionPrototype !== sessionPrototype) {
			throw new Error("Pi class identities changed while the guard was installed");
		}
		return;
	}

	state.settingsPrototype = settingsPrototype;
	state.sessionPrototype = sessionPrototype;

	for (const method of SETTINGS_WRITES_TO_SUPPRESS) {
		replaceMethod(settingsPrototype, method, (original) => {
			return function sessionScopedSettingsWrite(this: unknown, ...args: unknown[]): unknown {
				if (state.storage.getStore()?.suppressPersistence) return undefined;
				return Reflect.apply(original, this, args);
			};
		});
	}

	for (const method of SESSION_WRITES_TO_SUPPRESS) {
		replaceMethod(sessionPrototype, method, (original) => {
			return function sessionScopedMetadataWrite(this: unknown, ...args: unknown[]): unknown {
				if (state.storage.getStore()?.suppressPersistence) return suppressedAppendResult(this);
				return Reflect.apply(original, this, args);
			};
		});
	}

	state.originalGetBranch = replaceMethod(sessionPrototype, "getBranch", (original) => {
		return function sessionScopedGetBranch(this: unknown, ...args: unknown[]): unknown {
			const result = Reflect.apply(original, this, args);
			if (!Array.isArray(result)) throw new Error("getBranch() returned an unsupported shape");
			if (!shouldSuppressRestore(state, this, result)) return result;
			return result.filter((entry) => {
				if (typeof entry !== "object" || entry === null) return true;
				const type = (entry as { type?: unknown }).type;
				return type !== "model_change" && type !== "thinking_level_change";
			});
		};
	});

	replaceMethod(sessionPrototype, "buildSessionContext", (original) => {
		return function sessionScopedBuildSessionContext(this: unknown, ...args: unknown[]): unknown {
			const result = Reflect.apply(original, this, args);
			if (!shouldSuppressRestore(state, this)) return result;
			if (typeof result !== "object" || result === null || !Array.isArray((result as { messages?: unknown }).messages)) {
				throw new Error("buildSessionContext() returned an unsupported shape");
			}
			return {
				...(result as Record<string, unknown>),
				model: null,
				thinkingLevel: "off",
			};
		};
	});

	state.installed = true;
}

function incompatibleLease(reason: string): GuardLease {
	return {
		compatible: false,
		reason,
		markSessionReady: () => {},
		markSessionClosed: () => {},
		runSessionOnly: (operation) => operation(),
		isSessionOnlyActive: () => false,
	};
}

export function acquireGuard(targets: GuardTargets, options: GuardOptions): GuardLease {
	const host = options.stateHost ?? globalThis;
	// Always disable the 0.1.x process-wide guard, even when this Pi version is
	// unsupported and the new command must remain disabled.
	deactivateLegacyGuard(host);

	const versionAllowed =
		options.allowUntestedVersion === true ||
		isVersionSupported(options.version, options.minimumVersion, options.maximumVersionExclusive);
	if (!versionAllowed) {
		return incompatibleLease(
			`Pi ${options.version} is outside the tested range ${options.minimumVersion} <= version < ${options.maximumVersionExclusive}`,
		);
	}

	let state: SharedGuardState;
	try {
		state = getState(host, options.stateKey ?? DEFAULT_STATE_KEY);
		installPatches(state, targets);
	} catch (error) {
		return incompatibleLease(error instanceof Error ? error.message : String(error));
	}

	return {
		compatible: true,
		markSessionReady(sessionManager: object): void {
			state.readySessionManagers.add(sessionManager);
		},
		markSessionClosed(sessionManager: object): void {
			state.readySessionManagers.delete(sessionManager);
		},
		runSessionOnly<T>(operation: () => T): T {
			return state.storage.run(SUPPRESSION_CONTEXT, operation);
		},
		isSessionOnlyActive(): boolean {
			return state.storage.getStore()?.suppressPersistence === true;
		},
	};
}
