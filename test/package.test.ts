import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
// @ts-ignore JavaScript verification module without generated declarations.
import { assertRegistryVersionAbsent, classifyNpmViewFailure } from "../scripts/check-registry-version.mjs";
// @ts-ignore JavaScript verification module without generated declarations.
import { catalogInstallCommand, exactInstallCommand, matchesCanonicalRepository, matchesPiCatalogListing, normalizeRepositoryReference, validateProvenanceAudit } from "../scripts/verify-provenance.mjs";
// @ts-ignore JavaScript verification module without generated declarations.
import { assertPackFileList, expectedPackPaths, packOnce, validatePiManifest, verifyPackage } from "../scripts/verify-package.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("classifyNpmViewFailure distinguishes verified 404 from other lookup failures", () => {
	assert.equal(classifyNpmViewFailure("npm ERR! code E404", "", ""), "not-found");
	assert.equal(classifyNpmViewFailure("", "", "404 Not Found - GET https://registry.npmjs.org/foo"), "not-found");
	assert.equal(
		classifyNpmViewFailure("npm ERR! code E429", "rate limit exceeded", ""),
		"error",
	);
	assert.equal(
		classifyNpmViewFailure("npm ERR! code E401", "Unauthorized", ""),
		"error",
	);
	assert.equal(
		classifyNpmViewFailure("npm ERR! code E401", "authentication token not found", ""),
		"error",
	);
});

async function makeIsolatedRegistryCheckFixture() {
	const workDir = await mkdtemp(join(tmpdir(), "pi-registry-check-"));
	const binDir = join(workDir, "bin");
	await mkdir(binDir, { recursive: true });
	await cp(
		join(packageRoot, "scripts/check-registry-version.mjs"),
		join(workDir, "check-registry-version.mjs"),
	);
	const fakeNpmPath = join(binDir, "npm");
	const fakeNpmScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
const spec = args[1] ?? "";
if (spec.includes("absent-version")) {
  console.error("npm ERR! code E404");
  console.error("404 Not Found - GET https://registry.npmjs.org/test-package");
  process.exit(1);
}
if (spec.includes("present-version")) {
  console.log("1.0.0");
  process.exit(0);
}
if (spec.includes("outage-version")) {
  console.error("npm ERR! code E429");
  console.error("rate limit exceeded");
  process.exit(1);
}
console.error("unexpected npm invocation");
process.exit(2);
`;
	await writeFile(fakeNpmPath, fakeNpmScript, "utf8");
	await chmod(fakeNpmPath, 0o755);
	return { workDir, binDir, fakeNpmPath };
}

test("check-registry-version subprocess runs without node_modules", async () => {
	const { workDir, binDir, fakeNpmPath } = await makeIsolatedRegistryCheckFixture();
	const scriptPath = join(workDir, "check-registry-version.mjs");
	const env = {
		...process.env,
		PATH: `${binDir}:${process.env.PATH}`,
		NPM_BIN: fakeNpmPath,
	};
	try {
		const absent = await execFileAsync(process.execPath, [
			scriptPath,
			"test-package",
			"absent-version",
		], { cwd: workDir, env });
		assert.match(absent.stdout, /registry version not found/i);

		await assert.rejects(
			() =>
				execFileAsync(process.execPath, [scriptPath, "test-package", "present-version"], {
					cwd: workDir,
					env,
				}),
			/already exists/i,
		);

		await assert.rejects(
			() =>
				execFileAsync(process.execPath, [scriptPath, "test-package", "outage-version"], {
					cwd: workDir,
					env,
				}),
			/registry lookup failed/i,
		);

		await assertRegistryVersionAbsent("test-package", "absent-version", { npmPath: fakeNpmPath });
		await assert.rejects(
			() => assertRegistryVersionAbsent("test-package", "present-version", { npmPath: fakeNpmPath }),
			/already exists/i,
		);
		await assert.rejects(
			() => assertRegistryVersionAbsent("test-package", "outage-version", { npmPath: fakeNpmPath }),
			/registry lookup failed/i,
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test("validateProvenanceAudit rejects invalid signatures for bootstrap versions", () => {
	assert.throws(
		() =>
			validateProvenanceAudit(
				{ invalid: [{ name: "pi-session-only-model" }], verified: [], missing: [] },
				"pi-session-only-model",
				"0.0.0",
				"a".repeat(40),
			),
		/invalid registry signatures/i,
	);
});

test("validateProvenanceAudit allows bootstrap 0.0.0 without provenance", () => {
	const evidence = validateProvenanceAudit(
		{ invalid: [], verified: [], missing: [{ name: "pi-session-only-model" }] },
		"pi-session-only-model",
		"0.0.0",
		"a".repeat(40),
	);
	assert.equal(evidence.provenancePredicateTypes.length, 0);
});

test("validateProvenanceAudit requires provenance and rejects missing for OIDC releases", () => {
	assert.throws(
		() =>
			validateProvenanceAudit(
				{ invalid: [], verified: [], missing: [{ name: "pi-session-only-model" }] },
				"pi-session-only-model",
				"0.1.0",
				"a".repeat(40),
			),
		/missing registry signatures/i,
	);
	assert.throws(
		() =>
			validateProvenanceAudit(
				{ invalid: [], verified: [{ name: "pi-session-only-model", attestationBundles: [] }], missing: [] },
				"pi-session-only-model",
				"0.1.0",
				"a".repeat(40),
			),
		/missing provenance attestations/i,
	);
});

test("validateProvenanceAudit reads npm GitHub Actions SLSA v1 fields", () => {
	const commit = "f194f0829bf29cea7f1471a5de56ba156884c468";
	const payload = Buffer.from(
		JSON.stringify({
			predicate: {
				buildDefinition: {
					externalParameters: {
						workflow: { repository: "https://github.com/wh3at/pi-session-only-model" },
					},
					resolvedDependencies: [
						{
							uri: "git+https://github.com/wh3at/pi-session-only-model@refs/tags/v0.1.3",
							digest: { gitCommit: commit },
						},
					],
				},
			},
		}),
		"utf8",
	).toString("base64url");
	const evidence = validateProvenanceAudit(
		{
			invalid: [],
			missing: [],
			verified: [
				{
					name: "pi-session-only-model",
					attestationBundles: [
						{
							predicateType: "https://slsa.dev/provenance/v1",
							bundle: { dsseEnvelope: { payload } },
						},
					],
				},
			],
		},
		"pi-session-only-model",
		"0.1.3",
		commit,
	);
	assert.equal(evidence.sourceRepository, "https://github.com/wh3at/pi-session-only-model");
	assert.equal(evidence.sourceCommit, commit);
});

test("normalizeRepositoryReference accepts known git URL forms and rejects lookalikes", () => {
	const canonical = "wh3at/pi-session-only-model";
	assert.equal(
		normalizeRepositoryReference("git+https://github.com/wh3at/pi-session-only-model.git"),
		canonical,
	);
	assert.equal(
		normalizeRepositoryReference("https://github.com/wh3at/pi-session-only-model"),
		canonical,
	);
	assert.equal(
		normalizeRepositoryReference("git@github.com:wh3at/pi-session-only-model.git"),
		canonical,
	);
	assert.equal(normalizeRepositoryReference("github:wh3at/pi-session-only-model"), canonical);
	assert.equal(matchesCanonicalRepository("git+https://github.com/wh3at/pi-session-only-model.git"), true);
	assert.equal(
		matchesCanonicalRepository("https://github.com/wh3at/pi-session-only-model-evil"),
		false,
	);
	assert.equal(
		matchesCanonicalRepository("https://github.com/evil/wh3at/pi-session-only-model"),
		false,
	);
});

test("validateProvenanceAudit rejects provenance from a lookalike repository", () => {
	const commit = "f".repeat(40);
	const slsaPayload = Buffer.from(
		JSON.stringify({
			predicate: {
				buildDefinition: {
					externalParameters: {
						repository: "https://github.com/wh3at/pi-session-only-model-evil",
						sha: commit,
					},
				},
			},
		}),
		"utf8",
	).toString("base64url");
	assert.throws(
		() =>
			validateProvenanceAudit(
				{
					invalid: [],
					missing: [],
					verified: [
						{
							name: "pi-session-only-model",
							attestationBundles: [
								{
									predicateType: "https://slsa.dev/provenance/v1",
									bundle: { dsseEnvelope: { payload: slsaPayload } },
								},
							],
						},
					],
				},
				"pi-session-only-model",
				"0.1.3",
				commit,
			),
		/provenance repository mismatch/i,
	);
});

test("matchesPiCatalogListing uses unversioned Pi catalog install commands", async () => {
	const catalogHtml = await readFile(
		join(packageRoot, "test/fixtures/pi-catalog-sample.html"),
		"utf8",
	);
	const packageName = "pi-session-only-model";
	assert.equal(catalogInstallCommand(packageName), "pi install npm:pi-session-only-model");
	assert.equal(exactInstallCommand(packageName, "0.1.3"), "pi install npm:pi-session-only-model@0.1.3");
	assert.equal(matchesPiCatalogListing(catalogHtml, packageName), true);
	assert.equal(matchesPiCatalogListing(catalogHtml, "pi-mcp-adapter"), true);
	assert.equal(matchesPiCatalogListing(catalogHtml, "missing-package"), false);
	assert.equal(
		matchesPiCatalogListing(
			catalogHtml.replaceAll("pi install npm:pi-session-only-model", "pi install npm:pi-session-only-model@0.1.3"),
			packageName,
		),
		false,
	);
});

test("verify-release workflow keeps provenance and catalog verification contracts", async () => {
	const workflow = await readFile(join(packageRoot, ".github/workflows/verify-release.yml"), "utf8");
	const provenanceStep =
		workflow.match(
			/^      - name: Verify provenance and registry signatures[\s\S]*?^      - name: Install exact version in fresh Pi home/m,
		)?.[0] ?? "";
	const catalogStep =
		workflow.match(
			/^      - name: Poll Pi catalog with bounded hourly attempts[\s\S]*?^      - name: Upload verification evidence/m,
		)?.[0] ?? "";

	assert.match(provenanceStep, /--save-exact/);
	assert.doesNotMatch(provenanceStep, /--no-save/);
	assert.match(catalogStep, /catalog_install_command="pi install npm:\$\{PACKAGE_NAME\}"/);
	assert.doesNotMatch(catalogStep, /catalog_install_command="pi install npm:\$\{PACKAGE_NAME\}@\$\{INPUT_VERSION\}"/);
	assert.match(catalogStep, /exact_install_command="pi install npm:\$\{PACKAGE_NAME\}@\$\{INPUT_VERSION\}"/);
	assert.match(catalogStep, /catalogInstallCommand:/);
	assert.match(catalogStep, /exactInstallCommand:/);
	assert.match(catalogStep, /grep -Eq "pi install npm:\$\{PACKAGE_NAME\}\(\[\\"'<>]\|\$\)"/);
});

test("verify-provenance subprocess runs without node_modules", async () => {
	const workDir = await mkdtemp(join(tmpdir(), "pi-provenance-check-"));
	try {
		await cp(
			join(packageRoot, "scripts/verify-provenance.mjs"),
			join(workDir, "verify-provenance.mjs"),
		);
		const auditPath = join(workDir, "audit.json");
		await writeFile(
			auditPath,
			JSON.stringify({ invalid: [], verified: [], missing: [{ name: "pi-session-only-model" }] }),
			"utf8",
		);
		const { stdout } = await execFileAsync(
			process.execPath,
			[
				join(workDir, "verify-provenance.mjs"),
				auditPath,
				"pi-session-only-model",
				"0.0.0",
				"a".repeat(40),
			],
			{ cwd: workDir, env: { ...process.env, NODE_OPTIONS: undefined } },
		);
		const evidence = JSON.parse(stdout);
		assert.equal(evidence.provenancePredicateTypes.length, 0);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test("packed tarball contains only allowlisted runtime and documentation files", async () => {
	const workDir = await mkdtemp(join(tmpdir(), "pi-session-only-model-pack-"));
	try {
		const packed = await packOnce(packageRoot, workDir);
		const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		const allowed = expectedPackPaths(manifest.files);
		assertPackFileList(packed.files, allowed);
		assert.equal(packed.name, "pi-session-only-model");
		assert.equal(packed.version, manifest.version);
		assert.match(packed.digest, /^[a-f0-9]{64}$/);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test("untracked repository files do not expand the packed tarball", async () => {
	const sentinel = join(packageRoot, ".package-verify-sentinel");
	await writeFile(sentinel, "must-not-ship", "utf8");
	const workDir = await mkdtemp(join(tmpdir(), "pi-session-only-model-untracked-"));
	try {
		const packed = await packOnce(packageRoot, workDir);
		assert.equal(
			packed.files.some((file: string) => file.includes("package-verify-sentinel")),
			false,
		);
	} finally {
		await rm(sentinel, { force: true });
		await rm(workDir, { recursive: true, force: true });
	}
});

test("missing runtime files fail verification", async () => {
	const workDir = await mkdtemp(join(tmpdir(), "pi-session-only-model-missing-"));
	const fixtureRoot = join(workDir, "fixture");
	const packDir = join(workDir, "pack");
	await mkdir(fixtureRoot, { recursive: true });
	await mkdir(packDir, { recursive: true });
	for (const file of ["index.ts", "guard.ts", "README.md", "CHANGELOG.md", "LICENSE"]) {
		await copyFile(join(packageRoot, file), join(fixtureRoot, file));
	}
	const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	manifest.files = ["index.ts", "guard.ts", "command.ts", "picker.ts", "README.md", "CHANGELOG.md", "LICENSE"];
	await writeFile(join(fixtureRoot, "package.json"), JSON.stringify(manifest, null, 2), "utf8");

	try {
		const packed = await packOnce(fixtureRoot, packDir);
		const allowed = expectedPackPaths(manifest.files);
		assert.throws(
			() => assertPackFileList(packed.files, allowed),
			/missing required pack file/i,
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
});

test("malformed Pi metadata fails verification", () => {
	assert.throws(
		() =>
			validatePiManifest({
				name: "pi-session-only-model",
				keywords: ["pi-package"],
			}),
		/pi\.extensions/i,
	);
	assert.throws(
		() =>
			validatePiManifest({
				name: "pi-session-only-model",
				pi: { extensions: ["./index.ts"] },
				keywords: ["pi-extension"],
			}),
		/pi-package/i,
	);
});

test("repacked tarball digest mismatch is rejected as publish input", async () => {
	const packDir = await mkdtemp(join(tmpdir(), "pi-session-only-model-repack-"));
	const manifestPath = join(packageRoot, "package.json");
	const originalManifest = await readFile(manifestPath, "utf8");
	try {
		const baseline = await packOnce(packageRoot, packDir);
		const mutatedManifest = JSON.parse(originalManifest);
		mutatedManifest.description = `${mutatedManifest.description} repack-check`;
		await writeFile(manifestPath, JSON.stringify(mutatedManifest, null, 2), "utf8");
		await assert.rejects(
			() => verifyPackage({ packageRoot, expectedDigest: baseline.digest }),
			/digest mismatch/i,
		);
	} finally {
		await writeFile(manifestPath, originalManifest, "utf8");
		await rm(packDir, { recursive: true, force: true });
	}
});

test("package:verify proves tarball contents and extracted artifact behavior", async () => {
	const result = await verifyPackage({ packageRoot });
	assert.equal(result.name, "pi-session-only-model");
	assert.match(result.digest, /^[a-f0-9]{64}$/);
	assert.equal(result.typecheckPassed, true);
	assert.equal(result.smokePassed, true);
});
