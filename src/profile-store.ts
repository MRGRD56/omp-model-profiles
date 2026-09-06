import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { getAgentDir, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";

/**
 * A named, persisted snapshot of role → model-selector assignments.
 * `models` values are exact selector strings, e.g. `anthropic/claude:high`.
 * A missing key means "Auto" (clear the explicit assignment on apply).
 */
export interface ModelProfile {
	id: string;
	name: string;
	models: Record<string, string>;
	lastUsedAt?: number;
}

/** Schema v1 of `model-profiles.yml`. */
export interface ProfilesFile {
	version: 1;
	profiles: ModelProfile[];
}

export type ProfileStoreErrorKind = "schema" | "conflict" | "io";

export class ProfileStoreError extends Error {
	readonly kind: ProfileStoreErrorKind;
	readonly path: string;

	constructor(kind: ProfileStoreErrorKind, message: string, filePath: string) {
		super(message);
		this.name = "ProfileStoreError";
		this.kind = kind;
		this.path = filePath;
	}
}

const STORE_FILENAME = "model-profiles.yml";
// Bun emits a trailing space on empty mapping/list headers (`profiles: `).
const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

function emptyFile(): ProfilesFile {
	return { version: 1, profiles: [] };
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stringifyFile(file: ProfilesFile): string {
	const body = YAML.stringify(file, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
	return body.endsWith("\n") ? body : `${body}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(message: string, filePath: string): ProfileStoreError {
	return new ProfileStoreError("schema", message, filePath);
}

function assertKnownKeys(object: Record<string, unknown>, allowed: readonly string[], where: string, filePath: string): void {
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key)) {
			throw schemaError(`Unknown field "${key}" in ${where}`, filePath);
		}
	}
}

function validateProfiles(data: unknown, filePath: string): ProfilesFile {
	if (!isPlainObject(data)) throw schemaError("Top level must be a mapping", filePath);
	assertKnownKeys(data, ["version", "profiles"], "the profiles file", filePath);

	if (data.version !== 1) {
		throw schemaError(`Unsupported schema version ${JSON.stringify(data.version)} (expected 1)`, filePath);
	}
	if (!Array.isArray(data.profiles)) throw schemaError('"profiles" must be an array', filePath);

	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	const profiles: ModelProfile[] = [];

	for (const [index, item] of data.profiles.entries()) {
		const where = `profiles[${index}]`;
		if (!isPlainObject(item)) throw schemaError(`${where} must be a mapping`, filePath);
		assertKnownKeys(item, ["id", "name", "models", "lastUsedAt"], where, filePath);

		const { id, name, models, lastUsedAt } = item;
		if (typeof id !== "string" || id.length === 0) {
			throw schemaError(`${where}.id must be a non-empty string`, filePath);
		}
		if (seenIds.has(id)) throw schemaError(`Duplicate profile id "${id}"`, filePath);
		seenIds.add(id);

		let normalizedLastUsedAt: number | undefined;
		if (lastUsedAt !== undefined) {
			if (typeof lastUsedAt !== "number" || !Number.isSafeInteger(lastUsedAt) || lastUsedAt < 0) {
				throw schemaError(`${where}.lastUsedAt must be a non-negative safe integer`, filePath);
			}
			normalizedLastUsedAt = lastUsedAt;
		}
		if (typeof name !== "string" || name.trim().length === 0) {
			throw schemaError(`${where}.name must be a non-empty string`, filePath);
		}
		const normalizedName = name.trim();
		const normalizedNameKey = normalizedName.toLowerCase();
		if (seenNames.has(normalizedNameKey)) {
			throw schemaError(`Duplicate profile name "${normalizedName}"`, filePath);
		}
		seenNames.add(normalizedNameKey);

		if (!isPlainObject(models)) throw schemaError(`${where}.models must be a mapping`, filePath);
		const modelMap: Record<string, string> = {};
		for (const [role, selector] of Object.entries(models)) {
			if (role.length === 0) throw schemaError(`${where}.models contains an empty role key`, filePath);
			if (typeof selector !== "string" || selector.length === 0) {
				throw schemaError(`${where}.models["${role}"] must be a non-empty string`, filePath);
			}
			modelMap[role] = selector;
		}

		profiles.push({
			id,
			name: normalizedName,
			models: modelMap,
			...(normalizedLastUsedAt === undefined ? {} : { lastUsedAt: normalizedLastUsedAt }),
		});
	}

	return { version: 1, profiles };
}

function parseAndValidate(raw: string, filePath: string): ProfilesFile {
	let data: unknown;
	try {
		data = YAML.parse(raw);
	} catch (error) {
		throw schemaError(`Invalid YAML: ${toErrorMessage(error)}`, filePath);
	}
	return validateProfiles(data, filePath);
}

async function readRawOrNull(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

export function nextFreeName(profiles: readonly ModelProfile[]): string {
	const used = new Set(profiles.map(profile => profile.name.toLowerCase()));
	let n = 1;
	while (used.has(`profile ${n}`)) n++;
	return `Profile ${n}`;
}

/**
 * Versioned, conflict-safe YAML store for `model-profiles.yml`.
 *
 * A missing file means an empty store and is not created until the first
 * mutation. Every mutation re-reads the file under an advisory lock and aborts
 * with a conflict error when the bytes differ from the last read/committed
 * snapshot, so a concurrent OMP session can never be silently overwritten.
 */
export class ProfileStore {
	readonly filePath: string;

	#current: ProfilesFile = emptyFile();
	#expectedSource: string | null = null;
	#loaded = false;

	constructor(options: { agentDir?: string } = {}) {
		this.filePath = path.join(options.agentDir ?? getAgentDir(), STORE_FILENAME);
	}

	async load(): Promise<ProfilesFile> {
		const raw = await readRawOrNull(this.filePath);
		const file = raw === null ? emptyFile() : parseAndValidate(raw, this.filePath);
		this.#current = file;
		this.#expectedSource = raw;
		this.#loaded = true;
		return this.#current;
	}

	get profiles(): readonly ModelProfile[] {
		return this.#current.profiles;
	}

	async create(snapshot: Record<string, string>, name?: string): Promise<ModelProfile> {
		this.#assertLoaded();
		const next = this.#clone();
		const trimmed = name?.trim();
		if (trimmed === "") throw schemaError("Profile name must not be empty", this.filePath);
		const finalName = trimmed ?? nextFreeName(next.profiles);
		if (next.profiles.some(candidate => candidate.name.toLowerCase() === finalName.toLowerCase())) {
			throw schemaError(`A profile named "${finalName}" already exists`, this.filePath);
		}
		const profile: ModelProfile = {
			id: crypto.randomUUID(),
			name: finalName,
			models: { ...snapshot },
		};
		next.profiles.push(profile);
		await this.#persist(validateProfiles(next, this.filePath));
		return profile;
	}

	async rename(id: string, name: string): Promise<ModelProfile> {
		this.#assertLoaded();
		const trimmed = name.trim();
		const next = this.#clone();
		const profile = next.profiles.find(candidate => candidate.id === id);
		if (!profile) throw new ProfileStoreError("io", `Profile not found: ${id}`, this.filePath);
		if (trimmed.length === 0) throw schemaError("Profile name must not be empty", this.filePath);

		const trimmedKey = trimmed.toLowerCase();
		if (next.profiles.some(candidate => candidate.id !== id && candidate.name.toLowerCase() === trimmedKey)) {
			throw schemaError(`A profile named "${trimmed}" already exists`, this.filePath);
		}

		profile.name = trimmed;
		await this.#persist(validateProfiles(next, this.filePath));
		return profile;
	}

	async setModel(id: string, role: string, selector: string | undefined): Promise<ModelProfile> {
		this.#assertLoaded();
		if (role.length === 0) throw schemaError("Role must not be empty", this.filePath);
		const next = this.#clone();
		const profile = next.profiles.find(candidate => candidate.id === id);
		if (!profile) throw new ProfileStoreError("io", `Profile not found: ${id}`, this.filePath);

		if (selector === undefined) {
			delete profile.models[role];
		} else {
			if (selector.length === 0) throw schemaError("Selector must not be empty", this.filePath);
			profile.models[role] = selector;
		}

		await this.#persist(validateProfiles(next, this.filePath));
		return profile;
	}

	async markUsed(id: string, at = Date.now()): Promise<ModelProfile> {
		this.#assertLoaded();
		if (!Number.isSafeInteger(at) || at < 0) {
			throw schemaError("Usage timestamp must be a non-negative safe integer", this.filePath);
		}

		const next = this.#clone();
		const profile = next.profiles.find(candidate => candidate.id === id);
		if (!profile) throw new ProfileStoreError("io", `Profile not found: ${id}`, this.filePath);

		const latest = next.profiles.reduce(
			(max, candidate) => Math.max(max, candidate.lastUsedAt ?? -1),
			-1,
		);
		profile.lastUsedAt = Math.max(at, latest + 1);
		await this.#persist(validateProfiles(next, this.filePath));
		return profile;
	}

	async remove(id: string): Promise<void> {
		this.#assertLoaded();
		const next = this.#clone();
		const index = next.profiles.findIndex(profile => profile.id === id);
		if (index === -1) throw new ProfileStoreError("io", `Profile not found: ${id}`, this.filePath);
		next.profiles.splice(index, 1);
		await this.#persist(validateProfiles(next, this.filePath));
	}

	#assertLoaded(): void {
		if (!this.#loaded) throw new Error("ProfileStore.load() must complete before any mutation");
	}

	#clone(): ProfilesFile {
		return {
			version: 1,
			profiles: this.#current.profiles.map(profile => ({
				id: profile.id,
				name: profile.name,
				models: { ...profile.models },
				...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: profile.lastUsedAt }),
			})),
		};
	}

	async #persist(next: ProfilesFile): Promise<void> {
		const serialized = stringifyFile(next);
		const filePath = this.filePath;

		await withFileLock(filePath, async () => {
			const onDisk = await readRawOrNull(filePath);
			if (onDisk !== this.#expectedSource) {
				throw new ProfileStoreError("conflict", "Profiles changed on disk; reopen /profiles", filePath);
			}

			const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				await fs.writeFile(tempPath, serialized, "utf8");
				await replaceFileAtomically(tempPath, filePath);
			} catch (error) {
				await fs.rm(tempPath, { force: true }).catch(() => {});
				throw new ProfileStoreError("io", `Failed to write ${filePath}: ${toErrorMessage(error)}`, filePath);
			}
		});

		this.#current = next;
		this.#expectedSource = serialized;
	}
}
