import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	getModelPickerItems,
	getPickerModels,
	getThinkingPickerItems,
	filterModelPickerItems,
	pickSessionModel,
	type SessionModelPickerContext,
	type SessionModelSelection,
} from "../picker.ts";

function makeModel(
	provider: string,
	id: string,
	name: string,
	reasoning = true,
	thinkingLevelMap: Model<any>["thinkingLevelMap"] = { xhigh: "xhigh", max: "max" },
): Model<any> {
	return {
		provider,
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://example.test",
		reasoning,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function pickerContext(
	scopedModels: readonly Model<any>[], availableModels: readonly Model<any>[], inputs: string[],
): SessionModelPickerContext & { customCalls: () => number; availableCalls: () => number; notifications: string[] } {
	let customCalls = 0;
	let availableCalls = 0;
	const notifications: string[] = [];
	return {
		scopedModels: scopedModels.map((model) => ({ model })),
		modelRegistry: {
			getAvailable: () => {
				availableCalls++;
				return [...availableModels];
			},
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			custom: (async (factory: any) => {
				customCalls++;
				let result: SessionModelSelection | undefined;
				const component = await factory({}, {}, {}, (value: SessionModelSelection | undefined) => {
					result = value;
				});
				for (const input of inputs) component.handleInput?.(input);
				return result;
			}) as SessionModelPickerContext["ui"]["custom"],
		},
		customCalls: () => customCalls,
		availableCalls: () => availableCalls,
		notifications,
	};
}

test("prefers non-empty scoped models and falls back to available models", () => {
	const scoped = makeModel("scoped", "model", "Scoped");
	const available = makeModel("available", "model", "Available");
	assert.deepEqual(getPickerModels([{ model: scoped }], [available]), [scoped]);
	assert.deepEqual(getPickerModels([], [available]), [available]);
	assert.deepEqual(getPickerModels([], []), []);
});

test("model picker items keep provider-qualified IDs and search all model fields", () => {
	const model = makeModel("openrouter", "vendor/model", "Friendly display name");
	const [item] = getModelPickerItems([model]);
	assert.equal(item?.value, "openrouter/vendor/model");
	assert.equal(item?.label, "openrouter/vendor/model");
	assert.equal(item?.description, "Friendly display name");
	assert.equal(filterModelPickerItems([item!], "openrouter").length, 1);
	assert.equal(filterModelPickerItems([item!], "vendor/model").length, 1);
	assert.equal(filterModelPickerItems([item!], "friendly display").length, 1);
});

test("provider-qualified IDs disambiguate identical model IDs", () => {
	const items = getModelPickerItems([
		makeModel("alpha", "same", "Alpha"),
		makeModel("beta", "same", "Beta"),
	]);
	assert.deepEqual(items.map((item) => item.value), ["alpha/same", "beta/same"]);
	assert.deepEqual(filterModelPickerItems(items, "beta").map((item) => item.value), ["beta/same"]);
});

test("thinking items use only levels supported by the selected model", () => {
	const model = makeModel("test", "restricted", "Restricted", true, {
		off: null,
		minimal: "minimal",
		low: null,
		medium: "medium",
		high: "high",
		xhigh: undefined,
		max: undefined,
	});
	assert.deepEqual(
		getThinkingPickerItems(model).map((item) => item.value),
		["minimal", "medium", "high"],
	);
	assert.deepEqual(getThinkingPickerItems(makeModel("test", "plain", "Plain", false)).map((item) => item.value), ["off"]);
});

test("empty candidates notify without opening UI", async () => {
	const context = pickerContext([], [], []);
	assert.equal(await pickSessionModel(context), undefined);
	assert.equal(context.customCalls(), 0);
	assert.equal(context.notifications.some((message) => message.includes("No models")), true);
});

test("scoped candidates do not load the available catalog", async () => {
	const scoped = makeModel("scoped", "model", "Scoped");
	const context = pickerContext([scoped], [], ["\r", "\r"]);
	assert.deepEqual(await pickSessionModel(context), { model: scoped, thinkingLevel: "off" });
	assert.equal(context.availableCalls(), 0);
});

test("picker returns a model and explicitly selected thinking level", async () => {
	const model = makeModel("test", "m1", "Model One");
	const context = pickerContext([], [model], ["\r", "\u001b[B", "\r"]);
	assert.deepEqual(await pickSessionModel(context), { model, thinkingLevel: "minimal" satisfies ModelThinkingLevel });
});

test("search input filters the interactive model stage before confirmation", async () => {
	const alpha = makeModel("test", "alpha", "Alpha");
	const beta = makeModel("other", "beta", "Beta");
	const context = pickerContext([], [alpha, beta], ["beta", "\r", "\r"]);
	assert.deepEqual(await pickSessionModel(context), { model: beta, thinkingLevel: "off" });
});

test("cancelling model selection returns no result", async () => {
	const model = makeModel("test", "m1", "Model One");
	const context = pickerContext([], [model], ["\u001b"]);
	assert.equal(await pickSessionModel(context), undefined);
});

test("cancelling thinking selection returns no result after model selection", async () => {
	const model = makeModel("test", "m1", "Model One");
	const context = pickerContext([], [model], ["\r", "\u001b"]);
	assert.equal(await pickSessionModel(context), undefined);
});
