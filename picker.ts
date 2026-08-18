import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ScopedModel } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	SelectList,
	Spacer,
	Text,
	type Focusable,
	type SelectItem,
} from "@earendil-works/pi-tui";

export interface ModelPickerItem extends SelectItem {
	model: Model<Api>;
	searchText: string;
}

export interface ThinkingPickerItem extends SelectItem {
	thinkingLevel: ModelThinkingLevel;
}

export interface SessionModelSelection {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
}

export interface SessionModelPickerContext {
	scopedModels: readonly ScopedModel[];
	modelRegistry: {
		getAvailable(): Model<Api>[];
	};
	ui: Pick<ExtensionUIContext, "custom" | "notify">;
}

const SELECT_LIST_THEME = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

/** Resolve the same candidate scope used by Pi's normal model selector. */
export function getPickerModels(
	scopedModels: readonly Pick<ScopedModel, "model">[],
	availableModels: readonly Model<Api>[],
): Model<Api>[] {
	return scopedModels.length > 0 ? scopedModels.map(({ model }) => model) : [...availableModels];
}

function modelSearchText(model: Model<Api>): string {
	return `${model.provider} ${model.provider}/${model.id} ${model.id} ${model.name}`;
}

/** Convert models to display/search items without mutating the model objects. */
export function getModelPickerItems(models: readonly Model<Api>[]): ModelPickerItem[] {
	return models.map((model) => ({
		model,
		value: `${model.provider}/${model.id}`,
		label: `${model.provider}/${model.id}`,
		description: model.name,
		searchText: modelSearchText(model),
	}));
}

/** Fuzzy-search provider, qualified ID, bare ID, and display name. */
export function filterModelPickerItems(items: readonly ModelPickerItem[], query: string): ModelPickerItem[] {
	if (!query.trim()) return [...items];
	return fuzzyFilter([...items], query, (item) => item.searchText);
}

export function getThinkingPickerItems(model: Model<Api>): ThinkingPickerItem[] {
	return getSupportedThinkingLevels(model)
		.filter((thinkingLevel) => !model.reasoning || thinkingLevel !== "off")
		.map((thinkingLevel) => ({
			thinkingLevel,
			value: thinkingLevel,
			label: thinkingLevel,
		}));
}

/** Fuzzy-search the thinking levels supported by the selected model. */
export function filterThinkingPickerItems(
	items: readonly ThinkingPickerItem[],
	query: string,
): ThinkingPickerItem[] {
	if (!query.trim()) return [...items];
	return fuzzyFilter([...items], query, (item) => item.label);
}

class SessionModelPickerComponent extends Container implements Focusable {
	private _focused = false;
	private phase: "model" | "thinking" | "done" = "model";
	private readonly done: (selection: SessionModelSelection | undefined) => void;
	private readonly modelItems: ModelPickerItem[];
	private readonly searchInput = new Input();
	private readonly thinkingSearchInput = new Input();
	private modelList: SelectList;
	private thinkingItems: ThinkingPickerItem[] = [];
	private thinkingModel: Model<Api> | undefined;
	private thinkingList: SelectList | undefined;

	constructor(modelItems: ModelPickerItem[], done: (selection: SessionModelSelection | undefined) => void) {
		super();
		this.done = done;
		this.modelItems = modelItems;
		this.modelList = this.createModelList(modelItems);
		this.renderModelStage();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.phase === "model";
		this.thinkingSearchInput.focused = value && this.phase === "thinking";
	}

	handleInput(data: string): void {
		if (this.phase === "done") return;
		if (this.phase === "thinking") {
			this.thinkingList?.handleInput(data);
			if (this.phase !== "thinking") return;
			const previousQuery = this.thinkingSearchInput.getValue();
			this.thinkingSearchInput.handleInput(data);
			const query = this.thinkingSearchInput.getValue();
			if (query !== previousQuery) this.updateThinkingList(query);
			return;
		}

		this.modelList.handleInput(data);
		if (this.phase !== "model") return;
		const previousQuery = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const query = this.searchInput.getValue();
		if (query !== previousQuery) this.updateModelList(query);
	}

	private createModelList(items: readonly ModelPickerItem[]): SelectList {
		const list = new SelectList([...items], 10, SELECT_LIST_THEME, {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 64,
		});
		list.onSelect = (item) => this.selectModel((item as ModelPickerItem).model);
		list.onCancel = () => this.cancel();
		return list;
	}

	private updateModelList(query: string): void {
		this.modelList = this.createModelList(filterModelPickerItems(this.modelItems, query));
		this.renderModelStage();
	}

	private renderModelStage(): void {
		this.clear();
		this.addChild(new Text("Select model", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.modelList);
	}

	private selectModel(model: Model<Api>): void {
		const thinkingItems = getThinkingPickerItems(model);
		if (thinkingItems.length === 0) {
			this.cancel();
			return;
		}

		this.phase = "thinking";
		this.thinkingItems = thinkingItems;
		this.thinkingModel = model;
		this.thinkingList = this.createThinkingList(model, thinkingItems);
		this.focused = this._focused;
		this.renderThinkingStage();
	}

	private createThinkingList(model: Model<Api>, items: readonly ThinkingPickerItem[]): SelectList {
		const list = new SelectList([...items], 10, SELECT_LIST_THEME, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 24,
		});
		list.onSelect = (item) => {
			this.phase = "done";
			this.done({ model, thinkingLevel: (item as ThinkingPickerItem).thinkingLevel });
		};
		list.onCancel = () => this.cancel();
		return list;
	}

	private updateThinkingList(query: string): void {
		if (!this.thinkingModel) return;
		this.thinkingList = this.createThinkingList(
			this.thinkingModel,
			filterThinkingPickerItems(this.thinkingItems, query),
		);
		this.renderThinkingStage();
	}

	private renderThinkingStage(): void {
		this.clear();
		this.addChild(new Text("Select thinking level", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.thinkingSearchInput);
		this.addChild(new Spacer(1));
		if (this.thinkingList) this.addChild(this.thinkingList);
	}

	private cancel(): void {
		if (this.phase === "done") return;
		this.phase = "done";
		this.done(undefined);
	}
}

/**
 * Open the two-stage picker. No session state is changed until the returned
 * model/thinking pair is applied by the command integration.
 */
export async function pickSessionModel(
	ctx: SessionModelPickerContext,
): Promise<SessionModelSelection | undefined> {
	const availableModels = ctx.scopedModels.length > 0 ? [] : ctx.modelRegistry.getAvailable();
	const items = getModelPickerItems(getPickerModels(ctx.scopedModels, availableModels));
	if (items.length === 0) {
		ctx.ui.notify("No models are available for this session.", "warning");
		return undefined;
	}

	return ctx.ui.custom((_, _theme, _keybindings, done) => new SessionModelPickerComponent(items, done));
}
