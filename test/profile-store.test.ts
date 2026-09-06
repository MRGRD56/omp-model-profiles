import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProfileStore, ProfileStoreError } from "../src/profile-store";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "omp-model-profiles-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function expectStoreError(promise: Promise<unknown>, kind: ProfileStoreError["kind"]): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ProfileStoreError);
		expect((error as ProfileStoreError).kind).toBe(kind);
		return;
	}
	throw new Error("Expected promise to reject with ProfileStoreError");
}

describe("ProfileStore", () => {
	test("missing file loads empty without creating it", async () => {
		const store = new ProfileStore({ agentDir: dir });
		const file = await store.load();
		expect(file).toEqual({ version: 1, profiles: [] });
		expect(await exists(store.filePath)).toBe(false);
	});

	test("create/rename/setModel/remove round-trips schema v1 with exact selectors", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();

		const first = await store.create({ default: "anthropic/claude:high", "custom-role": "openai/gpt" });
		expect(first.name).toBe("Profile 1");
		expect(first.models).toEqual({ default: "anthropic/claude:high", "custom-role": "openai/gpt" });
		expect(first.id).toBeTypeOf("string");

		const second = await store.create({});
		expect(second.name).toBe("Profile 2");

		const renamed = await store.rename(first.id, "  Work  ");
		expect(renamed.name).toBe("Work");

		const updated = await store.setModel(first.id, "default", "anthropic/claude:low");
		expect(updated.models.default).toBe("anthropic/claude:low");

		const cleared = await store.setModel(first.id, "custom-role", undefined);
		expect("custom-role" in cleared.models).toBe(false);

		await store.remove(second.id);
		expect(store.profiles.map(p => p.name)).toEqual(["Work"]);

		const raw = await readFile(store.filePath, "utf8");
		expect(raw).toContain("version: 1");
		expect(raw).toContain("anthropic/claude:low");
		expect(raw.endsWith("\n")).toBe(true);

		const reloaded = await new ProfileStore({ agentDir: dir }).load();
		expect(reloaded.profiles).toHaveLength(1);
		expect(reloaded.profiles[0]?.id).toBe(first.id);
		expect(reloaded.profiles[0]?.models.default).toBe("anthropic/claude:low");
	});

	test("blank and duplicate names are rejected without persisting", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const first = await store.create({});
		const second = await store.create({});

		await expectStoreError(store.rename(first.id, "   "), "schema");
		await expectStoreError(store.rename(second.id, "Profile 1"), "schema");
		await expectStoreError(store.rename(second.id, "profile 1"), "schema");
		await expectStoreError(store.rename(second.id, "PROFILE 1"), "schema");

		expect(store.profiles.map(p => p.name)).toEqual(["Profile 1", "Profile 2"]);
	});

	test("create accepts an explicit name and rejects duplicates", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const first = await store.create({}, "  Work  ");
		expect(first.name).toBe("Work");

		await expectStoreError(store.create({}, "work"), "schema");
		await expectStoreError(store.create({}, "   "), "schema");

		expect(store.profiles.map(p => p.name)).toEqual(["Work"]);
	});

	test("markUsed persists usage order and makes equal timestamps monotonic", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const first = await store.create({});
		const second = await store.create({});

		await store.markUsed(first.id, 1000);
		await store.markUsed(second.id, 1000);

		expect(store.profiles.find(profile => profile.id === first.id)?.lastUsedAt).toBe(1000);
		expect(store.profiles.find(profile => profile.id === second.id)?.lastUsedAt).toBe(1001);

		const raw = await readFile(store.filePath, "utf8");
		expect(raw).toContain("lastUsedAt: 1001");
		const reloaded = await new ProfileStore({ agentDir: dir }).load();
		expect(reloaded.profiles.find(profile => profile.id === second.id)?.lastUsedAt).toBe(1001);
	});

	test("malformed, unsupported-version and unknown-field YAML are schema errors and never overwritten", async () => {
		const malformed = "version: [\n";
		await writeFile(path.join(dir, "model-profiles.yml"), malformed, "utf8");
		await expectStoreError(new ProfileStore({ agentDir: dir }).load(), "schema");
		expect(await readFile(path.join(dir, "model-profiles.yml"), "utf8")).toBe(malformed);

		await writeFile(path.join(dir, "model-profiles.yml"), "version: 2\nprofiles: []\n", "utf8");
		await expectStoreError(new ProfileStore({ agentDir: dir }).load(), "schema");

		await writeFile(path.join(dir, "model-profiles.yml"), "version: 1\nprofiles: []\nunknown: x\n", "utf8");
		await expectStoreError(new ProfileStore({ agentDir: dir }).load(), "schema");
	});

	test("external change between load and save yields conflict and preserves external content", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const created = await store.create({ default: "provider/a" });

		const raw = await readFile(store.filePath, "utf8");
		await writeFile(store.filePath, raw.replace("Profile 1", "External"), "utf8");

		await expectStoreError(store.rename(created.id, "Renamed"), "conflict");

		const onDisk = await readFile(store.filePath, "utf8");
		expect(onDisk).toContain("External");
		expect(onDisk).not.toContain("Renamed");
	});
});
