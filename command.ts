export interface ModelReference {
	provider: string;
	id: string;
}

export function modelReferenceKey(model: Pick<ModelReference, "provider" | "id">): string {
	return `${model.provider}\u0000${model.id}`;
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
