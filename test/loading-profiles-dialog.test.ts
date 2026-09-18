import { describe, expect, test } from "bun:test";
import { visibleWidth, type Component, type Theme, type TUI } from "@oh-my-pi/pi-tui";
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

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("LoadingProfilesDialog", () => {
	test("stays blank until the delay, then renders loading and switches to the ready dialog", async () => {
		const pending = Promise.withResolvers<Component>();
		let loadStarted = false;
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
			load: () => {
				loadStarted = true;
				return pending.promise;
			},
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

		// Construction and even an event-loop turn before mounting must not load.
		await nextTurn();
		expect(loadStarted).toBe(false);
		expect(dialog.render(60)).toEqual([]);
		expect(loadStarted).toBe(false);
		await nextTurn();
		expect(loadStarted).toBe(true);
		dialog.handleInput("x");
		expect(receivedInput).toEqual([]);

		expect(loadingDelay).toBe(600);
		showLoading?.();
		const loading = dialog.render(60);
		expect(loading).toHaveLength(24);
		expect(loading[8]).toContain("Model Profiles");
		expect(loading.join("\n")).toContain("Loading model profiles…");
		expect(loading.join("\n")).toContain("Esc / Ctrl+C close");
		expect(loading.every(line => visibleWidth(line) <= 60)).toBe(true);
		expect(renderRequests).toBeGreaterThan(0);

		pending.resolve(readyDialog);
		await nextTurn();
		expect(dialog.render(60)).toEqual(["READY"]);
		dialog.handleInput("x");
		expect(receivedInput).toEqual(["x"]);
		dialog.dispose();
	});

	test("Ctrl+C closes during loading and a late result cannot reopen the dialog", async () => {
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

		dialog.render(60);
		await nextTurn();
		dialog.handleInput("\x03");
		expect(closed).toBe(1);
		expect(loadingCancelled).toBe(true);

		pending.resolve({
			render: () => ["MUST NOT RENDER"],
			dispose: () => {
				readyDialogDisposed = true;
			},
		});
		await nextTurn();

		expect(readyDialogDisposed).toBe(true);
		expect(dialog.render(60)).toEqual([]);
		dialog.handleInput("\x03");
		expect(closed).toBe(1);
	});

	test("fast loading never displays the spinner", async () => {
		let showLoading: (() => void) | undefined;
		const dialog = new LoadingProfilesDialog({ requestRender() {} } as unknown as TUI, theme, {
			load: async () => ({ render: () => ["READY"] }),
			done() {},
			onError: error => { throw error; },
			scheduleLoading: show => {
				showLoading = show;
				return () => {};
			},
		});
		expect(dialog.render(60)).toEqual([]);
		await nextTurn();
		expect(dialog.render(60)).toEqual(["READY"]);
		showLoading?.();
		expect(dialog.render(60)).toEqual(["READY"]);
		dialog.dispose();
	});

	test("closing after the blank frame cancels work before it starts", async () => {
		let started = false;
		let closed = 0;
		const dialog = new LoadingProfilesDialog({} as TUI, theme, {
			load: async () => {
				started = true;
				return { render: () => ["READY"] };
			},
			done: () => closed++,
			onError: error => { throw error; },
		});
		dialog.render(60);
		dialog.handleInput("\x1b");
		await nextTurn();
		expect(started).toBe(false);
		expect(closed).toBe(1);
	});

	test("a synchronous loading failure is reported and closes the overlay", async () => {
		const failure = new Error("Cannot read profiles");
		const errors: unknown[] = [];
		let closed = 0;
		const dialog = new LoadingProfilesDialog({} as TUI, theme, {
			load: () => { throw failure; },
			done: () => closed++,
			onError: error => errors.push(error),
		});
		dialog.render(60);
		await nextTurn();
		expect(errors).toEqual([failure]);
		expect(closed).toBe(1);
	});
});
