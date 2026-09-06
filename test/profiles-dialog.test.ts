import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth, type TUI } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { ModelBrowserItem } from "@oh-my-pi/pi-coding-agent/modes/components/model-browser";
import { ProfilesDialog } from "../src/profiles-dialog";
import { ProfileStore } from "../src/profile-store";
import type { ModelRef } from "../src/apply-profile";
import { asSettings, FakeSettings } from "./fake-settings";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "omp-model-profiles-dialog-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const tui = {
	terminal: { rows: 24, columns: 100 },
	requestRender: () => {},
} as unknown as TUI;

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getSymbolPreset: () => "ascii",
	symbol: (key: string) => (key === "icon.search" ? "/" : key === "cmd.plus" ? "+" : key),
	status: { success: "✓", enabled: "+", disabled: "!" },
	icon: { context: "ctx:" },
	nav: { cursor: ">" },
	boxRound: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	md: { quoteBorder: "|", hrChar: "-", colorSwatch: "[]" },
	spinnerFrames: ["-", "\\", "|", "/"],
	getSpinnerFrames: (_type: string) => ["-", "\\", "|", "/"],
} as unknown as Theme;

type TestModel = ModelBrowserItem["model"];

function fakeModel(provider: string, id: string): TestModel {
	const reasoning = id === "model-1";
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "",
		reasoning,
		thinking: reasoning
			? { mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" }
			: undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as TestModel;
}

function fakeModels() {
	const list: TestModel[] = [];
	for (let i = 1; i <= 15; i++) list.push(fakeModel("provider-a", `model-${i}`));
	for (let i = 1; i <= 10; i++) list.push(fakeModel("provider-b", `model-${i}`));
	return {
		list: () => [...list],
		resolve: (spec: string) =>
			list.find(model => spec === `${model.provider}/${model.id}` || spec.startsWith(`${model.provider}/${model.id}:`)),
	};
}

describe("ProfilesDialog", () => {
	test("full flow: create, search, pick model, rename, cancel delete, apply; widths stay bounded", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();

		const settings = new FakeSettings();
		settings.roleStorage = "global";
		settings.global = { default: "provider-a/model-1" };

		const models = fakeModels();
		const setModelCalls: ModelRef[] = [];
		let closed = false;
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(settings),
			models,
			pi: {
				setModel: async model => {
					setModelCalls.push(model);
					return true;
				},
				setThinkingLevel: () => {},
			},
			done: () => {
				closed = true;
			},
		});

		// Create two profiles from the empty state, each via the name prompt.
		await dialog.processInput("n");
		expect(dialog.debugState().mode).toBe("create-profile");
		await dialog.processInput("Profile 1");
		await dialog.processInput("\n");
		await dialog.processInput("n");
		await dialog.processInput("Profile 2");
		await dialog.processInput("\n");
		expect(dialog.debugState().profiles).toEqual(["Profile 1", "Profile 2"]);
		expect(dialog.debugState().selectedProfile).toBe("Profile 2");

		// Search filters names by substring; selection follows the query.
		await dialog.processInput("/");
		expect(dialog.debugState().mode).toBe("search-profiles");
		for (const ch of "2") await dialog.processInput(ch);
		expect(dialog.debugState().filteredProfileNames).toEqual(["Profile 2"]);

		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("browse");
		expect(dialog.debugState().filteredProfileNames).toEqual(["Profile 2"]);

		await dialog.processInput("/");
		await dialog.processInput("\x1b");
		expect(dialog.debugState().searchQuery).toBe("");
		expect(dialog.debugState().filteredProfileNames).toEqual(["Profile 1", "Profile 2"]);

		// Tab to details and open the first role's model picker.
		await dialog.processInput("\t");
		expect(dialog.debugState().panel).toBe("details");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-model");

		// Fuzzy-filter the catalog and save the current selection.
		for (const ch of "model-15") await dialog.processInput(ch);
		const pickBefore = dialog.debugState().pickModel as Record<string, unknown> | null;
		expect(pickBefore?.filteredItemCount).toBeGreaterThan(0);
		expect(pickBefore?.filteredItemCount).toBeLessThan(26);
		const chosenLabel = pickBefore?.selectedItemLabel as string;
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("browse");

		const profileTwo = store.profiles.find(p => p.name === "Profile 2");
		expect(profileTwo?.models.default).toBe(chosenLabel);

		// Rename the selected profile.
		await dialog.processInput("e");
		expect(dialog.debugState().mode).toBe("rename");
		expect(dialog.debugState().renameValue).toBe("Profile 2");
		await dialog.processInput("X");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("browse");
		expect(dialog.debugState().selectedProfile).toBe("Profile 2X");
		expect(store.profiles.find(p => p.id === profileTwo?.id)?.name).toBe("Profile 2X");

		// Cancel delete keeps the profile.
		await dialog.processInput("d");
		expect(dialog.debugState().mode).toBe("confirm-delete");
		await dialog.processInput("\x1b");
		expect(dialog.debugState().mode).toBe("browse");
		expect(store.profiles).toHaveLength(2);

		// Apply the profile from the profiles panel.
		await dialog.processInput("\t");
		expect(dialog.debugState().panel).toBe("profiles");
		await dialog.processInput("\n");
		expect(dialog.debugState().notice).toContain("Applied Profile 2X");
		expect(dialog.debugState().selectedProfile).toBe("Profile 2X");
		expect(dialog.debugState().selectedRole).toBe("default");
		expect(settings.getModelRoles()).toEqual({ default: chosenLabel });
		expect(setModelCalls.length).toBe(1);

		// Rendering stays within the terminal width in both layouts.
		for (const width of [60, 100]) {
			for (const line of dialog.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}

		expect(closed).toBe(false);
	});

	test("escape closes the overlay", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		let closed = false;
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(new FakeSettings()),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {
				closed = true;
			},
		});
		await dialog.processInput("\x1b");
		expect(closed).toBe(true);
	});

	test("create prompts for a name, defaults when empty, rejects duplicates", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(new FakeSettings()),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		// "n" opens the name prompt instead of creating immediately.
		await dialog.processInput("n");
		expect(dialog.debugState().mode).toBe("create-profile");

		for (const width of [40, 60, 100]) {
			for (const line of dialog.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}

		// Empty submit creates the suggested default name.
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("browse");
		expect(dialog.debugState().profiles).toEqual(["Profile 1"]);

		// A duplicate name surfaces an error and stays in the prompt.
		await dialog.processInput("n");
		await dialog.processInput("Profile 1");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("create-profile");
		expect(dialog.debugState().createError).toContain("already exists");

		expect(store.profiles).toHaveLength(1);

		// Esc cancels without creating.
		await dialog.processInput("\x1b");
		expect(dialog.debugState().mode).toBe("browse");
		expect(store.profiles).toHaveLength(1);

		// A custom name creates the profile verbatim (trimmed).
		await dialog.processInput("n");
		await dialog.processInput("  Work  ");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("browse");
		expect(store.profiles.map(p => p.name)).toEqual(["Profile 1", "Work"]);
	});
	test("sorts by last use, selects active profile, and refreshes order on reopen", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const active = await store.create({ default: "provider-a/model-1" }, "Active");
		const recent = await store.create({ default: "provider-a/model-2" }, "Recent");
		await store.markUsed(active.id, 1000);
		await store.markUsed(recent.id, 2000);

		const settings = new FakeSettings();
		settings.global = { default: "provider-a/model-1" };
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		expect(dialog.debugState().filteredProfileNames).toEqual(["Recent", "Active"]);
		expect(dialog.debugState().selectedProfile).toBe("Active");

		await dialog.processInput("\n");

		expect(dialog.debugState().filteredProfileNames).toEqual(["Recent", "Active"]);
		expect(dialog.debugState().selectedProfile).toBe("Active");
		expect(store.profiles.find(profile => profile.id === active.id)?.lastUsedAt).toBeGreaterThan(2000);

		const reopened = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});
		expect(reopened.debugState().filteredProfileNames).toEqual(["Active", "Recent"]);
		expect(reopened.debugState().selectedProfile).toBe("Active");
	});

	test("renders active profile state and a themed create action", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create({ default: "provider-a/model-1" }, "Active");
		await store.create({ default: "provider-a/model-2" }, "Other");

		const settings = new FakeSettings();
		settings.global = { default: "provider-a/model-1" };
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		let rendered = dialog.render(60).join("\n");
		expect(rendered).toContain("✓");
		expect(rendered).toContain("ACTIVE");
		expect(rendered).toContain("[ + New profile ]");

		await dialog.processInput("\x1b[B");
		await dialog.processInput("\x1b[B");
		expect(dialog.debugState().selectedProfile).toBeNull();
		rendered = dialog.render(60).join("\n");
		expect(rendered).toContain("> [ + New profile ]");
		await dialog.processInput("\t");
		expect(dialog.debugState().panel).toBe("profiles");
		await dialog.processInput("\x1b[C");
		expect(dialog.debugState().panel).toBe("profiles");

		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("create-profile");
	});

	test("model picker resolves thinking suffixes and keeps unavailable selectors out of the list", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const profile = await store.create({ default: "provider-a/model-1:high" }, "Work");
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(new FakeSettings()),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		await dialog.processInput("\t");
		await dialog.processInput("\n");
		let picker = dialog.debugState().pickModel as Record<string, unknown>;
		expect(picker.currentSelector).toBe("provider-a/model-1:high");
		expect(picker.resolvedCurrentSelector).toBe("provider-a/model-1");
		expect(picker.selectedItemLabel).toBe("provider-a/model-1");
		expect(picker.filteredItemCount).toBe(25);
		let rendered = dialog.render(100).join("\n");
		expect(rendered).toContain("Current assignment: provider-a/model-1:high");
		expect(rendered).not.toContain("Unavailable:");

		// The selected model opens only the efforts baked into its metadata.
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-effort");
		let effort = dialog.debugState().pickEffort as Record<string, unknown>;
		expect(effort.itemCount).toBe(4); // default + low/medium/high
		expect(effort.selectedItemLabel).toBe("high");
		rendered = dialog.render(100).join("\n");
		expect(rendered).toContain("Pick Reasoning Effort · Default");
		expect(rendered).toContain("low");
		expect(rendered).toContain("medium");
		expect(rendered).toContain("high");

		await dialog.processInput("\x1b[A");
		await dialog.processInput("\x1b[A");
		await dialog.processInput("\n");
		expect(store.profiles[0]?.models.default).toBe("provider-a/model-1:low");

		// Reopening the same model preselects its stored effort.
		await dialog.processInput("\n");
		await dialog.processInput("\n");
		effort = dialog.debugState().pickEffort as Record<string, unknown>;
		expect(effort.selectedItemLabel).toBe("low");
		await dialog.processInput("\x1b");
		await dialog.processInput("\x1b");

		await store.setModel(profile.id, "default", "missing/model:high");
		await dialog.processInput("\n");
		picker = dialog.debugState().pickModel as Record<string, unknown>;
		expect(picker.currentSelector).toBe("missing/model:high");
		expect(picker.resolvedCurrentSelector).toBeNull();
		expect(picker.filteredItemCount).toBe(25);
		rendered = dialog.render(100).join("\n");
		expect(rendered).toContain("Saved selector is not currently available: missing/model:high");
		expect(rendered).not.toContain("Unavailable:");

		// Delete clears the unavailable assignment back to Auto.
		await dialog.processInput("\x1b[3~");
		expect(dialog.debugState().mode).toBe("browse");
		expect(store.profiles[0]?.models.default).toBeUndefined();
	});

	test("shows the selection cursor only in the focused pane", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(new FakeSettings()),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});
		await dialog.processInput("n");
		await dialog.processInput("\n");

		let cursorLines = dialog.render(100).filter(line => line.includes(">"));
		expect(cursorLines).toHaveLength(1);
		expect(cursorLines[0].indexOf(">")).toBeLessThan(35);

		await dialog.processInput("\t");
		expect(dialog.debugState().panel).toBe("details");
		cursorLines = dialog.render(100).filter(line => line.includes(">"));
		expect(cursorLines).toHaveLength(1);
		expect(cursorLines[0].indexOf(">")).toBeGreaterThan(35);

		await dialog.processInput("\x1b[C");
		expect(dialog.debugState().panel).toBe("details");
		await dialog.processInput("\x1b[D");
		expect(dialog.debugState().panel).toBe("profiles");
		cursorLines = dialog.render(100).filter(line => line.includes(">"));
		expect(cursorLines).toHaveLength(1);
		expect(cursorLines[0].indexOf(">")).toBeLessThan(35);
	});

	test("every overlay mode renders within the terminal width", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const settings = new FakeSettings();
		settings.roleStorage = "global";
		settings.global = { default: "provider-a/model-1" };

		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		// Walk into every mode and assert the box chrome never overflows.
		await dialog.processInput("n"); // create-profile
		await dialog.processInput("\n"); // back to browse with a profile
		await dialog.processInput("/"); // search-profiles
		await dialog.processInput("\x1b"); // back to browse
		await dialog.processInput("e"); // rename
		await dialog.processInput("\x1b"); // back
		await dialog.processInput("d"); // confirm-delete
		await dialog.processInput("\x1b"); // back
		await dialog.processInput("\t"); // details
		await dialog.processInput("\n"); // pick-model

		for (const width of [40, 60, 100]) {
			for (const line of dialog.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
