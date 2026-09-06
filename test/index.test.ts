import { describe, expect, test } from "bun:test";
import extension from "../src";

describe("extension entry", () => {
	test("registers /profiles and the default shortcut, then guards non-TUI mode", async () => {
		const registered: Array<{ name: string; description?: string; handler: unknown }> = [];
		const shortcuts: Array<{ shortcut: string; description?: string; handler: unknown }> = [];
		const pi = {
			registerCommand(name: string, options: { description?: string; handler: unknown }) {
				registered.push({ name, description: options.description, handler: options.handler });
			},
			registerShortcut(shortcut: string, options: { description?: string; handler: unknown }) {
				shortcuts.push({ shortcut, description: options.description, handler: options.handler });
			},
			pi: {
				settings: {
					getGlobalSettings() {
						return {};
					},
				},
			},
		};

		extension(pi as never);

		expect(registered).toHaveLength(1);
		expect(registered[0]?.name).toBe("profiles");
		expect(registered[0]?.description).toBe("Manage model role profiles");
		expect(shortcuts).toHaveLength(1);
		expect(shortcuts[0]?.shortcut).toBe("ctrl+alt+p");
		expect(shortcuts[0]?.description).toBe("Open model profiles");

		const notifications: Array<{ message: string; type: string }> = [];
		let customCalled = false;
		const context = {
			mode: "print",
			ui: {
				notify(message: string, type: string) {
					notifications.push({ message, type });
				},
				custom() {
					customCalled = true;
				},
			},
		};
		const commandHandler = registered[0]!.handler as (args: string, ctx: unknown) => Promise<void>;
		const shortcutHandler = shortcuts[0]!.handler as (ctx: unknown) => Promise<void>;

		await commandHandler("", context);
		await shortcutHandler(context);

		expect(notifications).toEqual([
			{ message: "/profiles is available in TUI mode", type: "warning" },
			{ message: "/profiles is available in TUI mode", type: "warning" },
		]);
		expect(customCalled).toBe(false);
	});

	test("uses the configured profile shortcut from config.yml", () => {
		const shortcuts: string[] = [];
		const pi = {
			registerCommand() {},
			registerShortcut(shortcut: string) {
				shortcuts.push(shortcut);
			},
			pi: {
				settings: {
					getGlobalSettings() {
						return {
							modelProfilesExtension: {
								keybindings: {
									openProfiles: "Ctrl+Alt+Shift+P",
								},
							},
						};
					},
				},
			},
		};

		extension(pi as never);

		expect(shortcuts).toEqual(["ctrl+alt+shift+p"]);
	});
});
