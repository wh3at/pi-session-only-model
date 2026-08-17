import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionModelCommand } from "../command.ts";

test("classifies an empty invocation as the model picker", () => {
	assert.deepEqual(parseSessionModelCommand(""), { command: { action: "pick" } });
	assert.deepEqual(parseSessionModelCommand("   "), { command: { action: "pick" } });
});

test("supports reset without picker arguments", () => {
	assert.deepEqual(parseSessionModelCommand("reset"), { command: { action: "reset" } });
	assert.deepEqual(parseSessionModelCommand(" RESET "), { command: { action: "reset" } });
});

test("classifies direct model, thinking, and status inputs as unsupported", () => {
	for (const input of [
		"openrouter/tencent/hy3:free",
		"--thinking high",
		"--thinking=minimal",
		"status",
	]) {
		assert.deepEqual(parseSessionModelCommand(input), { command: { action: "unsupported" } });
	}
});
