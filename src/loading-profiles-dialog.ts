import {
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_LOADING_DELAY_MS = 600;
const SPINNER_INTERVAL_MS = 120;
const PANEL_WIDTH = 52;

export interface LoadingProfilesDialogDeps {
	load: () => Promise<Component>;
	done: () => void;
	onError: (error: unknown) => void;
	scheduleLoading?: (show: () => void, delayMs: number) => () => void;
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width);
	return clipped + padding(Math.max(0, width - visibleWidth(clipped)));
}

export class LoadingProfilesDialog implements Component {
	debugId = "loading-profiles-dialog";

	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #deps: LoadingProfilesDialogDeps;
	readonly #spinnerFrames: readonly string[];
	#cancelLoadingDelay: (() => void) | undefined;
	#spinnerTimer: NodeJS.Timeout | undefined;
	#spinnerIndex = 0;
	#showLoading = false;
	#dialog: Component | undefined;
	#disposed = false;

	constructor(tui: TUI, theme: Theme, deps: LoadingProfilesDialogDeps) {
		this.#tui = tui;
		this.#theme = theme;
		this.#deps = deps;
		this.#spinnerFrames = theme.getSpinnerFrames("activity");

		if (deps.scheduleLoading) {
			this.#cancelLoadingDelay = deps.scheduleLoading(() => this.#beginLoadingScreen(), DEFAULT_LOADING_DELAY_MS);
		} else {
			const loadingDelay = setTimeout(() => this.#beginLoadingScreen(), DEFAULT_LOADING_DELAY_MS);
			this.#cancelLoadingDelay = () => clearTimeout(loadingDelay);
		}
		void deps.load().then(
			dialog => this.#finishLoading(dialog),
			error => this.#failLoading(error),
		);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#dialog) {
			this.#dialog.handleInput?.(data);
			return;
		}
		if (data === "\x1b" || matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#disposed = true;
			this.#clearTimers();
			this.#deps.done();
		}
	}

	render(width: number): readonly string[] {
		if (this.#dialog) return this.#dialog.render(width);
		if (!this.#showLoading) return [];

		const panelWidth = Math.max(12, Math.min(PANEL_WIDTH, width));
		const innerWidth = Math.max(0, panelWidth - 4);
		const box = this.#theme.boxRound;
		const spinner = this.#spinnerFrames[this.#spinnerIndex % Math.max(1, this.#spinnerFrames.length)] ?? "·";
		const title = truncateToWidth(" Model Profiles ", Math.max(0, panelWidth - 4));
		const topFill = Math.max(0, panelWidth - 3 - visibleWidth(title));
		const lines = [
			this.#theme.fg("border", box.topLeft + box.horizontal) +
				this.#theme.bold(this.#theme.fg("accent", title)) +
				this.#theme.fg("border", box.horizontal.repeat(topFill) + box.topRight),
			`${this.#theme.fg("border", box.vertical)} ${fit("", innerWidth)} ${this.#theme.fg("border", box.vertical)}`,
			`${this.#theme.fg("border", box.vertical)} ${fit(`${this.#theme.fg("accent", spinner)} Loading model profiles…`, innerWidth)} ${this.#theme.fg("border", box.vertical)}`,
			`${this.#theme.fg("border", box.vertical)} ${fit("", innerWidth)} ${this.#theme.fg("border", box.vertical)}`,
			this.#theme.fg("border", box.teeRight + box.horizontal.repeat(Math.max(0, panelWidth - 2)) + box.teeLeft),
			`${this.#theme.fg("border", box.vertical)} ${fit(this.#theme.fg("dim", "Esc close"), innerWidth)} ${this.#theme.fg("border", box.vertical)}`,
			this.#theme.fg("border", box.bottomLeft + box.horizontal.repeat(Math.max(0, panelWidth - 2)) + box.bottomRight),
		];
		const left = padding(Math.max(0, Math.floor((width - panelWidth) / 2)));
		const visibleLines = lines.slice(0, this.#tui.terminal.rows);
		const top = Math.max(0, Math.floor((this.#tui.terminal.rows - visibleLines.length) / 2));
		const bottom = Math.max(0, this.#tui.terminal.rows - top - visibleLines.length);
		return [
			...Array.from({ length: top }, () => ""),
			...visibleLines.map(line => left + line),
			...Array.from({ length: bottom }, () => ""),
		];
	}

	invalidate(): void {
		this.#dialog?.invalidate?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clearTimers();
		this.#dialog?.dispose?.();
		this.#dialog = undefined;
	}

	#beginLoadingScreen(): void {
		if (this.#disposed || this.#dialog) return;
		this.#showLoading = true;
		this.#spinnerTimer = setInterval(() => {
			this.#spinnerIndex++;
			this.#tui.requestRender();
		}, SPINNER_INTERVAL_MS);
		this.#tui.requestRender();
	}

	#finishLoading(dialog: Component): void {
		if (this.#disposed) {
			dialog.dispose?.();
			return;
		}
		this.#clearTimers();
		this.#dialog = dialog;
		this.#tui.requestRender();
	}

	#failLoading(error: unknown): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clearTimers();
		this.#deps.onError(error);
		this.#deps.done();
	}

	#clearTimers(): void {
		this.#cancelLoadingDelay?.();
		clearInterval(this.#spinnerTimer);
		this.#cancelLoadingDelay = undefined;
		this.#spinnerTimer = undefined;
	}
}
