import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
// @ts-ignore JavaScript verification module without generated declarations.
import { assertPackFileList, classifyNpmViewFailure, expectedPackPaths, packOnce, validatePiManifest, validateProvenanceAudit, verifyPackage } from "../scripts/verify-package.mjs";

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
	manifest.files = ["index.ts", "guard.ts", "command.ts", "README.md", "CHANGELOG.md", "LICENSE"];
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
