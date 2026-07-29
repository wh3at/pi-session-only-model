export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SessionThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelReference {
	provider: string;
	id: string;
}

export type SessionModelCommand =
	| { action: "status" }
	| { action: "reset" }
	| { action: "set"; model?: ModelReference; thinkingLevel?: SessionThinkingLevel };

export interface ParseResult {
	command?: SessionModelCommand;
	error?: string;
}

function parseModelReference(value: string): ModelReference | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return {
		provider: value.slice(0, separator),
		id: value.slice(separator + 1),
	};
}

function parseThinkingLevel(value: string): SessionThinkingLevel | undefined {
	return (THINKING_LEVELS as readonly string[]).includes(value) ? (value as SessionThinkingLevel) : undefined;
}

export function parseSessionModelCommand(rawArgs: string): ParseResult {
	const trimmed = rawArgs.trim();
	if (!trimmed || trimmed.toLowerCase() === "status") return { command: { action: "status" } };
	if (trimmed.toLowerCase() === "reset") return { command: { action: "reset" } };

	const tokens = trimmed.split(/\s+/);
	let model: ModelReference | undefined;
	let thinkingLevel: SessionThinkingLevel | undefined;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--thinking") {
			const value = tokens[++index];
			if (!value) return { error: "--thinking requires a level" };
			thinkingLevel = parseThinkingLevel(value);
			if (!thinkingLevel) return { error: `Unknown thinking level: ${value}` };
			continue;
		}
		if (token.startsWith("--thinking=")) {
			const value = token.slice("--thinking=".length);
			thinkingLevel = parseThinkingLevel(value);
			if (!thinkingLevel) return { error: `Unknown thinking level: ${value || "(empty)"}` };
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown option: ${token}` };
		if (model) return { error: `Unexpected argument: ${token}` };
		model = parseModelReference(token);
		if (!model) return { error: `Model must use provider/model-id form: ${token}` };
	}

	if (!model && !thinkingLevel) return { error: "A model or --thinking level is required" };
	return { command: { action: "set", model, thinkingLevel } };
}
