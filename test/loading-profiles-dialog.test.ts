import { describe, expect, test } from "bun:test";
import { visibleWidth, type Component, type TUI } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { LoadingProfilesDialog } from "../src/loading-profiles-dialog";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	boxRound: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeLeft: "+",
		teeRight: "+",
	},
	getSpinnerFrames: () => ["-", "\\", "|", "/"],
} as unknown as Theme;

describe("LoadingProfilesDialog", () => {
	test("stays blank until the delay, then renders loading and switches to the ready dialog", async () => {
		const pending = Promise.withResolvers<Component>();
		let renderRequests = 0;
		let showLoading: (() => void) | undefined;
		let loadingDelay: number | undefined;
		const receivedInput: string[] = [];
		const readyDialog: Component = {
			render: () => ["READY"],
			handleInput: data => receivedInput.push(data),
		};
		const tui = {
			terminal: { rows: 24, columns: 100 },
			requestRender: () => renderRequests++,
		} as unknown as TUI;
		const dialog = new LoadingProfilesDialog(tui, theme, {
			load: () => pending.promise,
			done: () => {},
			onError: error => {
				throw error;
			},
			scheduleLoading: (show, delayMs) => {
				showLoading = show;
				loadingDelay = delayMs;
				return () => {};
			},
		});

		expect(dialog.render(60)).toEqual([]);
		dialog.handleInput("x");
		expect(receivedInput).toEqual([]);

		expect(loadingDelay).toBe(600);
		showLoading?.();
		const loading = dialog.render(60);
		expect(loading).toHaveLength(24);
		expect(loading[8]).toContain("Model Profiles");
		expect(loading.join("\n")).toContain("Loading model profiles…");
		expect(loading.join("\n")).toContain("Esc close");
		expect(loading.every(line => visibleWidth(line) <= 60)).toBe(true);
		expect(renderRequests).toBeGreaterThan(0);

		pending.resolve(readyDialog);
		await pending.promise;
		expect(dialog.render(60)).toEqual(["READY"]);
		dialog.handleInput("x");
		expect(receivedInput).toEqual(["x"]);
		dialog.dispose();
	});

	test("escape closes during loading and a late result cannot reopen the dialog", async () => {
		const pending = Promise.withResolvers<Component>();
		let closed = 0;
		let loadingCancelled = false;
		let readyDialogDisposed = false;
		const tui = {
			terminal: { rows: 24, columns: 100 },
			requestRender: () => {},
		} as unknown as TUI;
		const dialog = new LoadingProfilesDialog(tui, theme, {
			load: () => pending.promise,
			done: () => closed++,
			onError: error => {
				throw error;
			},
			scheduleLoading: () => () => {
				loadingCancelled = true;
			},
		});

		dialog.handleInput("\x1b");
		expect(closed).toBe(1);
		expect(loadingCancelled).toBe(true);

		pending.resolve({
			render: () => ["MUST NOT RENDER"],
			dispose: () => {
				readyDialogDisposed = true;
			},
		});
		await pending.promise;

		expect(readyDialogDisposed).toBe(true);
		expect(dialog.render(60)).toEqual([]);
		dialog.handleInput("\x1b");
		expect(closed).toBe(1);
	});
});
