export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SessionThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelReference {
	provider: string;
	id: string;
}

export type SessionModelCommand =
	| { action: "pick" }
	| { action: "reset" }
	| { action: "unsupported" };

export interface ParseResult {
	command: SessionModelCommand;
}

export function parseSessionModelCommand(rawArgs: string): ParseResult {
	const trimmed = rawArgs.trim();
	if (!trimmed) return { command: { action: "pick" } };
	if (trimmed.toLowerCase() === "reset") return { command: { action: "reset" } };
	return { command: { action: "unsupported" } };
}
