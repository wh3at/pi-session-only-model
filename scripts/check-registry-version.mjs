import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @param {string} stderr
 * @param {string} stdout
 * @param {string} message
 * @returns {"not-found" | "exists" | "error"}
 */
export function classifyNpmViewFailure(stderr, stdout, message) {
	const combined = `${stderr}\n${stdout}\n${message}`;
	if (/\bE404\b/.test(combined) || /404 Not Found/i.test(combined)) {
		return "not-found";
	}
	if (/EEXIST|already exists/i.test(combined)) {
		return "exists";
	}
	return "error";
}

/**
 * @param {string} packageName
 * @param {string} version
 * @param {{ npmPath?: string }} [options]
 */
export async function assertRegistryVersionAbsent(packageName, version, options = {}) {
	const npmPath = options.npmPath ?? "npm";
	try {
		await execFileAsync(npmPath, ["view", `${packageName}@${version}`, "version"], {
			env: process.env,
		});
		throw new Error(`registry version already exists: ${packageName}@${version}`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("already exists")) {
			throw error;
		}
		const execError = /** @type {NodeJS.ErrnoException & { stdout?: string; stderr?: string }} */ (
			error
		);
		const outcome = classifyNpmViewFailure(
			String(execError.stderr ?? ""),
			String(execError.stdout ?? ""),
			String(execError.message ?? ""),
		);
		if (outcome === "not-found") {
			return;
		}
		const detail = [execError.stderr, execError.stdout, execError.message]
			.filter(Boolean)
			.join("\n")
			.trim();
		throw new Error(`registry lookup failed: ${detail || "unknown npm view error"}`);
	}
}

async function main() {
	const packageName = process.argv[2] ?? process.env.PACKAGE_NAME;
	const version = process.argv[3] ?? process.env.PACKAGE_VERSION;
	if (!packageName || !version) {
		throw new Error(
			"usage: node scripts/check-registry-version.mjs <package-name> <version>",
		);
	}
	const npmPath = process.env.NPM_BIN ?? "npm";
	await assertRegistryVersionAbsent(packageName, version, { npmPath });
	console.log(`registry version not found (expected): ${packageName}@${version}`);
}

function isCliMain() {
	const entry = process.argv[1];
	return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isCliMain()) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
