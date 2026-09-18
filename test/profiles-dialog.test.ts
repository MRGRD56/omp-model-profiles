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
			? {
					mode: "effort",
					efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
					defaultLevel: "medium",
				}
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

	test("search keeps the selected profile and uses safe fallbacks", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create({ default: "provider-a/model-1" }, "Alpha");
		await store.create({ default: "provider-a/model-1" }, "Beta");

		const settings = new FakeSettings();
		settings.global = { default: "provider-a/model-1" };
		let switched = 0;
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: {
				setModel: async () => {
					switched++;
					return true;
				},
				setThinkingLevel: () => {},
			},
			done: () => {},
		});

		await dialog.processInput("\x1b[B");
		expect(dialog.debugState().selectedProfile).toBe("Beta");

		await dialog.processInput("/");
		for (const ch of "Beta") await dialog.processInput(ch);
		expect(dialog.debugState().selectedProfile).toBe("Beta");
		await dialog.processInput("\n");
		await dialog.processInput("\n");
		expect(dialog.debugState().selectedProfile).toBe("Beta");
		expect(dialog.debugState().notice).toContain("Applied Beta");
		expect(switched).toBe(1);
		await dialog.processInput("/");
		await dialog.processInput("\x1b");
		expect(dialog.debugState().selectedProfile).toBe("Beta");

		await dialog.processInput("/");
		await dialog.processInput("a");
		expect(dialog.debugState().selectedProfile).toBe("Beta");
		await dialog.processInput("\x7f");
		expect(dialog.debugState().selectedProfile).toBe("Beta");
		await dialog.processInput("\x1b");
		expect(dialog.debugState().selectedProfile).toBe("Beta");

		await dialog.processInput("/");
		for (const ch of "zzz") await dialog.processInput(ch);
		expect(dialog.debugState().selectedProfile).toBeNull();
		await dialog.processInput("\x1b");
		expect(dialog.debugState().selectedProfile).toBe("Alpha");

		await dialog.processInput("\x1b[B");
		await dialog.processInput("/");
		for (const ch of "Alpha") await dialog.processInput(ch);
		expect(dialog.debugState().selectedProfile).toBe("Alpha");
	});

	test("keeps delete conflicts visible in the confirmation screen", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create({ default: "provider-a/model-1" }, "Work");
		const competing = new ProfileStore({ agentDir: dir });
		await competing.load();
		await competing.create({ default: "provider-a/model-1" }, "Other");

		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(new FakeSettings()),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		await dialog.processInput("d");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("confirm-delete");
		expect(store.profiles).toHaveLength(1);
		const error = dialog.debugState().error as string;
		expect(error).toBeTruthy();
		expect(dialog.render(60).join("\n")).toContain(error);

		await dialog.processInput("\x1b");
		expect(dialog.debugState().mode).toBe("browse");
	});

	test("retries a failed deletion without closing the confirmation screen", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create({ default: "provider-a/model-1" }, "Work");
		let attempts = 0;
		const remove = store.remove.bind(store);
		store.remove = async id => {
			attempts++;
			if (attempts === 1) throw new Error("delete refused for test");
			await remove(id);
		};

		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(new FakeSettings()),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		await dialog.processInput("d");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("confirm-delete");
		expect(dialog.render(60).join("\n")).toContain("delete refused for test");
		expect(store.profiles).toHaveLength(1);

		await dialog.processInput("\n");
		expect(attempts).toBe(2);
		expect(dialog.debugState().mode).toBe("browse");
		expect(store.profiles).toHaveLength(0);
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
		const other = await store.create({ default: "provider-a/model-2" }, "Other");

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
		settings.global = { default: "provider-a/model-2" };
		rendered = dialog.render(60).join("\n");
		const activeLine = rendered.split("\n").find(line => line.includes("Active"));
		const otherLine = rendered.split("\n").find(line => line.includes("Other"));
		expect(activeLine).toBeDefined();
		expect(activeLine).not.toContain("ACTIVE");
		expect(otherLine).toContain("ACTIVE");

		await store.rename(other.id, "Renamed");
		rendered = dialog.render(60).join("\n");
		expect(rendered).toContain("Renamed");
		expect(rendered).not.toContain("Other");

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

	test("uses role tags as labels and selectors as descriptions", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create(
			{ default: "provider-a/model-1:high", designer: "provider-a/model-2" },
			"Roles",
		);

		const settings = new FakeSettings();
		settings.cycleOrder = ["designer", "title"];
		settings.global = {
			default: "provider-a/model-1:high",
			designer: "provider-a/model-2",
		};
		const dialog = new ProfilesDialog(tui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		await dialog.processInput("\t");
		const rendered = dialog.render(100).join("\n");
		const defaultLine = rendered.split("\n").find(line => line.includes("DEFAULT"));

		expect(defaultLine).toBeDefined();
		expect(defaultLine?.indexOf("DEFAULT") ?? -1).toBeLessThan(
			defaultLine?.indexOf("provider-a/model-1:high") ?? -1,
		);
		expect(defaultLine).not.toContain(" · DEFAULT");
		expect(rendered).not.toContain("Default");
		expect(rendered).not.toContain("Fast");
		expect(rendered).not.toContain("Thinking");
		expect(rendered).toContain("designer");
		expect(rendered).toContain("title");
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
		expect(effort.itemCount).toBe(7); // default + min/low/medium/high/xhigh/max
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

	test("Ctrl+C closes from every nested screen", async () => {
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create({ default: "provider-a/model-1:high" }, "Work");

		const enterNestedModes: Array<{ mode: string; enter: (dialog: ProfilesDialog<TestModel>) => Promise<void> }> = [
			{ mode: "browse", enter: async () => {} },
			{ mode: "search-profiles", enter: dialog => dialog.processInput("/") },
			{ mode: "rename", enter: dialog => dialog.processInput("e") },
			{ mode: "create-profile", enter: dialog => dialog.processInput("n") },
			{ mode: "confirm-delete", enter: dialog => dialog.processInput("d") },
			{
				mode: "pick-model",
				enter: async dialog => {
					await dialog.processInput("\t");
					await dialog.processInput("\n");
				},
			},
			{
				mode: "pick-effort",
				enter: async dialog => {
					await dialog.processInput("\t");
					await dialog.processInput("\n");
					await dialog.processInput("\n");
				},
			},
		];

		for (const nested of enterNestedModes) {
			let closed = 0;
			const dialog = new ProfilesDialog(tui, theme, {
				store,
				settings: asSettings(new FakeSettings()),
				models: fakeModels(),
				pi: { setModel: async () => true, setThinkingLevel: () => {} },
				done: () => closed++,
			});
			await nested.enter(dialog);
			expect(dialog.debugState().mode).toBe(nested.mode);
			await dialog.processInput("\x03");
			expect(closed).toBe(1);
		}
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

	test("every overlay mode renders within terminal width and height", async () => {
		const terminal = { rows: 24, columns: 100 };
		const localTui = { terminal, requestRender: () => {} } as unknown as TUI;
		const fits = (dialog: ProfilesDialog<TestModel>) => {
			for (const width of [40, 60, 100]) {
				const lines = dialog.render(width);
				expect(lines.length).toBeLessThanOrEqual(terminal.rows);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		};
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		const settings = new FakeSettings();
		settings.roleStorage = "global";
		settings.global = { default: "provider-a/model-1" };

		const dialog = new ProfilesDialog(localTui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		fits(dialog);
		await dialog.processInput("n");
		expect(dialog.debugState().mode).toBe("create-profile");
		fits(dialog);
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("browse");
		fits(dialog);
		await dialog.processInput("/");
		expect(dialog.debugState().mode).toBe("search-profiles");
		fits(dialog);
		await dialog.processInput("\x1b");
		await dialog.processInput("e");
		expect(dialog.debugState().mode).toBe("rename");
		fits(dialog);
		await dialog.processInput("\x1b");
		await dialog.processInput("d");
		expect(dialog.debugState().mode).toBe("confirm-delete");
		fits(dialog);
		await dialog.processInput("\x1b");
		await dialog.processInput("\t");
		fits(dialog);
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-model");
		fits(dialog);
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-effort");
		fits(dialog);
	});

	test("picker windows follow terminal height and recover selection", async () => {
		const terminal = { rows: 24, columns: 100 };
		const localTui = { terminal, requestRender: () => {} } as unknown as TUI;
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create({ default: "provider-a/model-1" }, "Work");
		const settings = new FakeSettings();
		settings.global = { default: "provider-a/model-1" };
		let closed = false;
		const dialog = new ProfilesDialog(localTui, theme, {
			store,
			settings: asSettings(settings),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {
				closed = true;
			},
		});

		await dialog.processInput("\t");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-model");
		terminal.rows = 10;
		let rendered = dialog.render(60);
		expect(rendered.length).toBeLessThanOrEqual(10);
		expect(rendered.join("\n")).toContain("model-1");

		for (const ch of "model-2") await dialog.processInput(ch);
		expect((dialog.debugState().pickModel as Record<string, unknown>)?.query).toBe("model-2");
		const originalSelector = store.profiles[0]?.models.default;

		terminal.rows = 5;
		rendered = dialog.render(60);
		expect(rendered.length).toBeLessThanOrEqual(5);
		expect(rendered.join("\n")).toContain("Terminal too small");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-model");
		expect(store.profiles[0]?.models.default).toBe(originalSelector);

		terminal.rows = 10;
		rendered = dialog.render(60);
		expect(rendered.length).toBeLessThanOrEqual(10);
		expect((dialog.debugState().pickModel as Record<string, unknown>)?.query).toBe("model-2");
		expect(rendered.join("\n")).toContain("model-2");

		terminal.rows = 5;
		dialog.render(60);
		await dialog.processInput("\x1b");
		expect(closed).toBe(true);
	});

	test("effort list uses available height, keeps selection visible, and restores", async () => {
		const terminal = { rows: 24, columns: 100 };
		const localTui = { terminal, requestRender: () => {} } as unknown as TUI;
		const store = new ProfileStore({ agentDir: dir });
		await store.load();
		await store.create({ default: "provider-a/model-1" }, "Work");
		const dialog = new ProfilesDialog(localTui, theme, {
			store,
			settings: asSettings(new FakeSettings()),
			models: fakeModels(),
			pi: { setModel: async () => true, setThinkingLevel: () => {} },
			done: () => {},
		});

		await dialog.processInput("\t");
		await dialog.processInput("\n");
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-effort");
		let rendered = dialog.render(60);
		expect(rendered.length).toBeLessThanOrEqual(24);
		for (const effort of ["default", "min", "low", "medium", "high", "xhigh", "max"]) {
			expect(rendered.join("\n")).toContain(effort);
		}

		terminal.rows = 10;
		rendered = dialog.render(60);
		expect(rendered.length).toBeLessThanOrEqual(10);
		const visibleAtTen = ["default", "min", "low", "medium", "high", "xhigh", "max"].filter(effort =>
			rendered.join("\n").includes(effort),
		);
		expect(visibleAtTen.length).toBeLessThanOrEqual(5);
		for (let i = 0; i < 3; i++) await dialog.processInput("\x1b[B");
		expect((dialog.debugState().pickEffort as Record<string, unknown>)?.selectedItemLabel).toBe("max");
		rendered = dialog.render(60);
		expect(rendered.join("\n")).toContain("max");

		const setModel = store.setModel.bind(store);
		store.setModel = async () => {
			throw new Error("effort refused for test");
		};
		await dialog.processInput("\n");
		expect(dialog.debugState().mode).toBe("pick-effort");
		rendered = dialog.render(60);
		expect(rendered.length).toBeLessThanOrEqual(10);
		expect(rendered.join("\n")).toContain("effort refused for test");
		const visibleWithStatus = ["default", "min", "low", "medium", "high", "xhigh", "max"].filter(effort =>
			rendered.join("\n").includes(effort),
		);
		expect(visibleWithStatus.length).toBeLessThanOrEqual(4);

		terminal.rows = 24;
		rendered = dialog.render(60);
		expect(rendered.length).toBeLessThanOrEqual(24);
		expect((dialog.debugState().pickEffort as Record<string, unknown>)?.selectedItemLabel).toBe("max");
		for (const effort of ["default", "min", "low", "medium", "high", "xhigh", "max"]) {
			expect(rendered.join("\n")).toContain(effort);
		}
		store.setModel = setModel;
	});
});
