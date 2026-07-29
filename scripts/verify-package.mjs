import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * @param {string[]} filesField
 * @returns {Set<string>}
 */
export function expectedPackPaths(filesField) {
	const allowed = new Set(["package.json"]);
	for (const file of filesField ?? []) {
		allowed.add(file);
	}
	return allowed;
}

/**
 * @param {unknown} manifest
 */
export function validatePiManifest(manifest) {
	if (!manifest || typeof manifest !== "object") {
		throw new Error("package manifest must be an object");
	}
	const pi = /** @type {{ pi?: { extensions?: unknown } }} */ (manifest).pi;
	if (!Array.isArray(pi?.extensions) || pi.extensions.length === 0) {
		throw new Error("package manifest must declare pi.extensions");
	}
	const keywords = /** @type {{ keywords?: unknown }} */ (manifest).keywords;
	if (!Array.isArray(keywords) || !keywords.includes("pi-package")) {
		throw new Error('package manifest must include the "pi-package" keyword');
	}
}

/**
 * @param {string[]} actualFiles
 * @param {Set<string>} allowedPaths
 */
export function assertPackFileList(actualFiles, allowedPaths) {
	const actual = new Set(actualFiles);
	const unexpected = [...actual].filter((file) => !allowedPaths.has(file));
	if (unexpected.length > 0) {
		throw new Error(`unexpected pack files: ${unexpected.sort().join(", ")}`);
	}
	for (const required of allowedPaths) {
		if (!actual.has(required)) {
			throw new Error(`missing required pack file: ${required}`);
		}
	}
}

/**
 * @param {string} filePath
 */
export async function sha256File(filePath) {
	const data = await readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

/**
 * @param {string} root
 * @param {string} packDestination
 */
export async function packOnce(root, packDestination) {
	await mkdir(packDestination, { recursive: true });
	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--pack-destination", packDestination, "--json"],
		{ cwd: root, env: process.env },
	);
	const results = JSON.parse(stdout);
	const pack = Array.isArray(results) ? results.at(-1) : results;
	if (!pack?.filename || !Array.isArray(pack.files)) {
		throw new Error("npm pack did not return machine-readable pack metadata");
	}
	const tarballPath = join(packDestination, pack.filename);
	const files = pack.files.map((entry) => entry.path);
	const digest = await sha256File(tarballPath);
	return {
		tarballPath,
		filename: pack.filename,
		files,
		name: pack.name,
		version: pack.version,
		digest,
	};
}

/**
 * @param {string} tarballPath
 * @param {string} destination
 */
export async function extractTarball(tarballPath, destination) {
	await mkdir(destination, { recursive: true });
	await execFileAsync("tar", ["-xzf", tarballPath, "-C", destination], { cwd: packageRoot });
	return join(destination, "package");
}

/**
 * @param {string} extractedDir
 * @param {string} typesRoot
 */
export async function typecheckExtractedPackage(extractedDir, typesRoot) {
	const tsconfigPath = join(extractedDir, ".verify-tsconfig.json");
	const tscPath = join(typesRoot, "node_modules", "typescript", "bin", "tsc");
	await writeFile(
		tsconfigPath,
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					allowImportingTsExtensions: true,
					types: ["node"],
					typeRoots: [join(typesRoot, "node_modules", "@types")],
					baseUrl: typesRoot,
					paths: {
						"@earendil-works/pi-coding-agent": [
							"node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts",
						],
					},
				},
				include: ["*.ts"],
			},
			null,
			2,
		),
		"utf8",
	);
	await execFileAsync(process.execPath, [tscPath, "--noEmit", "-p", tsconfigPath], {
		cwd: extractedDir,
		env: process.env,
	});
}

/**
 * @param {string} extensionDir
 * @param {string} extensionSourceDir
 */
async function installExtensionSources(extensionDir, extensionSourceDir) {
	for (const entry of await readdir(extensionSourceDir)) {
		await cp(join(extensionSourceDir, entry), join(extensionDir, entry), { recursive: true });
	}
}

/**
 * @param {{
 *   extensionSourceDir?: string;
 *   repoRoot?: string;
 * }} [options]
 */
export async function makeFixture(options = {}) {
	const root = options.repoRoot ?? packageRoot;
	const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-session-only-model-integration-"));
	const cwd = join(fixtureRoot, "cwd");
	const agentDir = join(fixtureRoot, "agent");
	const extensionDir = join(agentDir, "extensions", "pi-session-only-model");
	await mkdir(cwd, { recursive: true });
	await mkdir(extensionDir, { recursive: true });
	const sourceDir = options.extensionSourceDir ?? root;
	if (options.extensionSourceDir) {
		await installExtensionSources(extensionDir, sourceDir);
	} else {
		for (const file of ["index.ts", "guard.ts", "command.ts"]) {
			await cp(join(sourceDir, file), join(extensionDir, file));
		}
	}
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{ defaultProvider: "test", defaultModel: "m1", defaultThinkingLevel: "medium" },
			null,
			2,
		),
		"utf8",
	);

	const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider("test", {
		baseUrl: "https://example.invalid/v1",
		apiKey: "dummy",
		api: "openai-completions",
		models: ["m1", "m2", "m3"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		})),
	});

	return {
		root: fixtureRoot,
		cwd,
		agentDir,
		modelRuntime,
		async cleanup(session) {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			await rm(fixtureRoot, { recursive: true, force: true });
		},
	};
}

/**
 * @param {string} extensionSourceDir
 * @param {string} [repoRoot]
 */
export async function smokeExtensionFromExtracted(extensionSourceDir, repoRoot = packageRoot) {
	const fixture = await makeFixture({ extensionSourceDir, repoRoot });
	let session;
	try {
		const settingsManager = SettingsManager.create(fixture.cwd, fixture.agentDir);
		const sessionManager = SessionManager.inMemory(fixture.cwd);
		({ session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRuntime: fixture.modelRuntime,
			settingsManager,
			sessionManager,
			noTools: "all",
		}));
		await session.bindExtensions({ mode: "print" });
		assert.equal(typeof session.prompt, "function");
	} finally {
		await fixture.cleanup(session);
	}
}

/**
 * @param {string} extractedDir
 * @param {string} repoRoot
 */
export async function smokeExtractedPackage(extractedDir, repoRoot) {
	await smokeExtensionFromExtracted(extractedDir, repoRoot);
}

/**
 * @param {{
 *   packageRoot?: string;
 *   expectedDigest?: string;
 *   keepWorkDir?: boolean;
 * }} [options]
 */
export async function verifyPackage(options = {}) {
	const root = options.packageRoot ?? packageRoot;
	const workDir = await mkdtemp(join(tmpdir(), "pi-session-only-model-verify-"));
	const packDir = join(workDir, "pack");
	const extractRoot = join(workDir, "extract");

	try {
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		validatePiManifest(manifest);

		const packed = await packOnce(root, packDir);
		const allowed = expectedPackPaths(manifest.files);
		assertPackFileList(packed.files, allowed);

		if (options.expectedDigest && packed.digest !== options.expectedDigest) {
			throw new Error(
				`digest mismatch: expected ${options.expectedDigest}, received ${packed.digest}`,
			);
		}

		const extractedDir = await extractTarball(packed.tarballPath, extractRoot);
		const extractedManifest = JSON.parse(await readFile(join(extractedDir, "package.json"), "utf8"));
		validatePiManifest(extractedManifest);

		await typecheckExtractedPackage(extractedDir, root);
		await smokeExtractedPackage(extractedDir, root);

		return {
			name: packed.name,
			version: packed.version,
			digest: packed.digest,
			files: packed.files,
			tarballPath: packed.tarballPath,
			extractedDir,
			typecheckPassed: true,
			smokePassed: true,
			workDir: options.keepWorkDir ? workDir : undefined,
		};
	} finally {
		if (!options.keepWorkDir) {
			await rm(workDir, { recursive: true, force: true });
		}
	}
}

async function main() {
	const result = await verifyPackage();
	console.log(
		`package:verify ok ${result.name}@${result.version} digest=${result.digest} files=${result.files.length}`,
	);
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
