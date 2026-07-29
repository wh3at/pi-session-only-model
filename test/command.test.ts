import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionModelCommand } from "../command.ts";

test("preserves slashes and colons inside an OpenRouter model id", () => {
	assert.deepEqual(parseSessionModelCommand("openrouter/tencent/hy3:free"), {
		command: {
			action: "set",
			model: { provider: "openrouter", id: "tencent/hy3:free" },
			thinkingLevel: undefined,
		},
	});
});

test("parses thinking as a separate option instead of a model-id suffix", () => {
	assert.deepEqual(parseSessionModelCommand("openrouter/tencent/hy3:free --thinking high"), {
		command: {
			action: "set",
			model: { provider: "openrouter", id: "tencent/hy3:free" },
			thinkingLevel: "high",
		},
	});
	assert.deepEqual(parseSessionModelCommand("--thinking=minimal"), {
		command: { action: "set", model: undefined, thinkingLevel: "minimal" },
	});
});

test("supports status and reset", () => {
	assert.deepEqual(parseSessionModelCommand(""), { command: { action: "status" } });
	assert.deepEqual(parseSessionModelCommand("status"), { command: { action: "status" } });
	assert.deepEqual(parseSessionModelCommand("reset"), { command: { action: "reset" } });
});

test("rejects malformed references and options", () => {
	assert.match(parseSessionModelCommand("hy3:free").error ?? "", /provider\/model-id/);
	assert.match(parseSessionModelCommand("openrouter/tencent/hy3:free --thinking turbo").error ?? "", /Unknown thinking/);
	assert.match(parseSessionModelCommand("openrouter/a extra").error ?? "", /Unexpected argument/);
});
