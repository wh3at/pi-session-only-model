/**
 * Dependency-free provenance audit validation for post-release verification.
 */

import { pathToFileURL } from "node:url";

const CANONICAL_REPO = "wh3at/pi-session-only-model";

/**
 * @param {string} value
 * @returns {string | null}
 */
export function normalizeRepositoryReference(value) {
	const text = String(value ?? "").trim();
	if (!text) {
		return null;
	}

	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
		return text;
	}

	const githubShorthand = text.match(/^github:([^/]+\/[^/#?]+)/i);
	if (githubShorthand) {
		return githubShorthand[1];
	}

	const ssh = text.match(/^git@github\.com:([^/]+\/[^/#?]+?)(?:\.git)?$/i);
	if (ssh) {
		return ssh[1];
	}

	const https = text.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
	if (https) {
		return https[1];
	}

	return null;
}

/**
 * @param {string} value
 * @param {string} [canonicalRepo]
 */
export function matchesCanonicalRepository(value, canonicalRepo = CANONICAL_REPO) {
	return normalizeRepositoryReference(value) === canonicalRepo;
}

/**
 * @param {string} packageName
 */
export function catalogInstallCommand(packageName) {
	return `pi install npm:${packageName}`;
}

/**
 * @param {string} packageName
 * @param {string} version
 */
export function exactInstallCommand(packageName, version) {
	return `pi install npm:${packageName}@${version}`;
}

/**
 * @param {string} catalogHtml
 * @param {string} packageName
 */
export function matchesPiCatalogListing(catalogHtml, packageName) {
	const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`pi install npm:${escaped}(["'<>]|$)`);
	return pattern.test(catalogHtml);
}

/**
 * @param {unknown} audit
 * @param {string} packageName
 * @param {string} version
 * @param {string} expectedCommit
 */
export function validateProvenanceAudit(audit, packageName, version, expectedCommit) {
	if (!audit || typeof audit !== "object") {
		throw new Error("npm audit signatures output must be an object");
	}
	const record = /** @type {{ invalid?: unknown[]; missing?: unknown[]; verified?: Array<{ name?: string; attestationBundles?: unknown[] }> }} */ (
		audit
	);
	if ((record.invalid ?? []).length > 0) {
		throw new Error(`invalid registry signatures: ${JSON.stringify(record.invalid)}`);
	}

	const target = (record.verified ?? []).find((entry) => entry.name === packageName);
	const provenanceEvidence = {
		package: packageName,
		version,
		verifiedTargetFound: Boolean(target),
		invalid: record.invalid ?? [],
		missing: record.missing ?? [],
		provenancePredicateTypes: /** @type {string[]} */ ([]),
		sourceRepository: null,
		sourceCommit: null,
	};

	if (target?.attestationBundles?.length) {
		for (const bundle of target.attestationBundles) {
			const attestation = /** @type {{ predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } } } */ (
				bundle
			);
			if (attestation.predicateType) {
				provenanceEvidence.provenancePredicateTypes.push(attestation.predicateType);
			}
			const payload = attestation.bundle?.dsseEnvelope?.payload;
			if (!payload) continue;
			const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
			const predicate = decoded.predicate ?? decoded;
			const resolvedDependencies = predicate?.buildDefinition?.resolvedDependencies ?? [];
			const sourceDependency = resolvedDependencies.find(
				(dependency) => dependency?.digest?.gitCommit,
			);
			const sourceUri =
				predicate?.invocation?.configSource?.uri ??
				predicate?.buildDefinition?.externalParameters?.workflow?.repository ??
				predicate?.buildDefinition?.externalParameters?.repository ??
				predicate?.repository?.url ??
				sourceDependency?.uri ??
				null;
			const sourceCommit =
				predicate?.invocation?.configSource?.digest?.gitCommit ??
				predicate?.buildDefinition?.externalParameters?.sha ??
				predicate?.source?.commit?.sha ??
				sourceDependency?.digest?.gitCommit ??
				null;
			if (sourceUri) provenanceEvidence.sourceRepository = sourceUri;
			if (sourceCommit) provenanceEvidence.sourceCommit = sourceCommit;
		}
	}

	const hasProvenance = provenanceEvidence.provenancePredicateTypes.length > 0;

	if (version === "0.0.0") {
		if (!hasProvenance) {
			return provenanceEvidence;
		}
	} else {
		if ((record.missing ?? []).length > 0) {
			throw new Error(`missing registry signatures: ${JSON.stringify(record.missing)}`);
		}
		if (!hasProvenance) {
			throw new Error(
				`missing provenance attestations for ${packageName}@${version}; OIDC releases must carry provenance`,
			);
		}
	}

	if (hasProvenance) {
		const repoText = String(provenanceEvidence.sourceRepository ?? "");
		if (!matchesCanonicalRepository(repoText)) {
			throw new Error(`provenance repository mismatch: ${repoText}`);
		}
		if (provenanceEvidence.sourceCommit !== expectedCommit) {
			throw new Error(
				`provenance commit mismatch: expected ${expectedCommit}, received ${provenanceEvidence.sourceCommit}`,
			);
		}
	}

	return provenanceEvidence;
}

async function main() {
	const auditPath = process.argv[2];
	const packageName = process.argv[3] ?? process.env.PACKAGE_NAME;
	const version = process.argv[4] ?? process.env.INPUT_VERSION;
	const expectedCommit = process.argv[5] ?? process.env.EXPECTED_COMMIT;
	if (!auditPath || !packageName || !version || !expectedCommit) {
		throw new Error(
			"usage: node scripts/verify-provenance.mjs <audit.json> <package-name> <version> <expected-commit>",
		);
	}
	const { readFile } = await import("node:fs/promises");
	const audit = JSON.parse(await readFile(auditPath, "utf8"));
	const evidence = validateProvenanceAudit(audit, packageName, version, expectedCommit);
	console.log(JSON.stringify(evidence));
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
