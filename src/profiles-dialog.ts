import {
	extractPrintableText,
	Input,
	matchesKey,
	padding,
	SelectList,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type SymbolTheme,
	type TUI,
} from "@oh-my-pi/pi-tui";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import {
	buildBrowserItems,
	ModelBrowser,
	sortModelItems,
	type ModelBrowserItem,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-browser";
import { parseModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getThinkingLevelMetadata } from "@oh-my-pi/pi-coding-agent/thinking";
import { applyProfile, isProfileActive, type ApplyModels, type ApplySession } from "./apply-profile";
import type { ModelProfile, ProfileStore } from "./profile-store";
import { nextFreeName } from "./profile-store";
import { orderedRoleIds, roleDisplayName, roleTag, snapshotModelRoles } from "./roles";

const MIN_LIST_ROWS = 5;
const WIDE_MIN_COLUMNS = 72;
const DEFAULT_EFFORT_VALUE = "__default_effort__";
const CREATE_VALUE = "__create__";

type PickerModel = ModelBrowserItem["model"];
type PickerEffort = NonNullable<PickerModel["thinking"]>["efforts"][number];

export interface ProfilesDialogDeps<M extends PickerModel = PickerModel> {
	store: ProfileStore;
	settings: Settings;
	models: ApplyModels<M> & { list(): M[] };
	pi: ApplySession<M>;
	done: () => void;
}
type Mode = "browse" | "search-profiles" | "rename" | "create-profile" | "confirm-delete" | "pick-model" | "pick-effort";
type Panel = "profiles" | "details";

type SidebarItem = { kind: "profile"; profile: ModelProfile } | { kind: "create" };

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function isEnter(data: string): boolean {
	return data === "\n" || data === "\r" || matchesKey(data, "enter");
}

function isEscape(data: string): boolean {
	return matchesKey(data, "escape") || data === "\x1b";
}

interface StatusText {
	text: string;
	color: ThemeColor;
}

// ────────────────────────────────────────────────────────────────────────────
// OMP box-drawing chrome, parameterized by the host-provided theme.
//
// The plugin runs in its own module graph (jiti resolves deps from the
// plugin's node_modules), so OMP's exported theme singleton is initially a
// different, uninitialized instance. The dialog installs the host-provided
// Theme into that graph before constructing native components; local chrome
// still receives the same live Theme explicitly.
// ────────────────────────────────────────────────────────────────────────────

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

function paint(theme: Theme, s: string, color?: ThemeColor): string {
	return theme.fg(color ?? "border", s);
}

function topBorder(theme: Theme, width: number, title: string): string {
	const box = theme.boxRound;
	const inner = Math.max(0, width - 2);
	if (!title) return paint(theme, box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(theme, box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(theme, box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

function divider(theme: Theme, width: number): string {
	const box = theme.boxRound;
	return paint(theme, box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

function bottomBorder(theme: Theme, width: number): string {
	const box = theme.boxRound;
	return paint(theme, box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

function row(theme: Theme, content: string, width: number): string {
	const box = theme.boxRound;
	return `${paint(theme, box.vertical)} ${fit(content, Math.max(0, width - 4))} ${paint(theme, box.vertical)}`;
}

function splitBodyWidth(width: number, sidebarWidth: number): number {
	return Math.max(0, width - sidebarWidth - 7);
}

function topBorderSplit(theme: Theme, width: number, title: string, sidebarWidth: number): string {
	const box = theme.boxRound;
	const dividerCol = sidebarWidth + 3;
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	let left: string;
	if (!title) {
		left = paint(theme, box.topLeft + box.horizontal.repeat(leftLen));
	} else {
		const shown = truncateToWidth(` ${title} `, Math.max(0, leftLen - 1));
		const fillWidth = Math.max(0, leftLen - 1 - visibleWidth(shown));
		left =
			paint(theme, box.topLeft + box.horizontal) +
			theme.bold(theme.fg("accent", shown)) +
			paint(theme, box.horizontal.repeat(fillWidth));
	}
	return left + paint(theme, box.teeDown + box.horizontal.repeat(rightLen) + box.topRight);
}

function dividerSplit(theme: Theme, width: number, sidebarWidth: number): string {
	const box = theme.boxRound;
	const dividerCol = sidebarWidth + 3;
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	return paint(
		theme,
		box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft,
	);
}

function splitRow(theme: Theme, sidebar: string, body: string, width: number, sidebarWidth: number): string {
	const box = theme.boxRound;
	const bodyWidth = splitBodyWidth(width, sidebarWidth);
	const bar = paint(theme, box.vertical);
	return `${bar} ${fit(sidebar, sidebarWidth)} ${bar} ${fit(body, bodyWidth)} ${bar}`;
}

/** Mirrors OMP's `getSelectListTheme()` + `getSymbolTheme()` against the host theme. */
function makeSelectListTheme(theme: Theme, focused: boolean): SelectListTheme {
	const preset = theme.getSymbolPreset();
	const symbols: SymbolTheme = {
		cursor: focused ? theme.nav.cursor : " ",
		inputCursor: preset === "ascii" ? "|" : "▏",
		boxRound: theme.boxRound,
		boxSharp: theme.boxSharp,
		table: theme.boxSharp,
		quoteBorder: theme.md.quoteBorder,
		hrChar: theme.md.hrChar,
		colorSwatch: theme.md.colorSwatch,
		spinnerFrames: theme.getSpinnerFrames("activity"),
	};
	return {
		selectedPrefix: text => theme.fg("accent", text),
		selectedText: text => theme.fg("accent", text),
		description: text => theme.fg("muted", text),
		scrollInfo: text => theme.fg("muted", text),
		noMatch: text => theme.fg("muted", text),
		symbols,
		icon: text => theme.fg("muted", text),
		hovered: text => theme.bg("selectedBg", text),
	};
}

/**
 * Two-panel `/profiles` overlay implemented as a small finite state machine.
 * Rendered with the same box-drawing chrome and `SelectList` styling as OMP's
 * own overlays (`/model`, `Models` hub): rounded borders, accent cursor,
 * muted descriptions, dim footer hints.
 */
export class ProfilesDialog<M extends PickerModel = PickerModel> implements Component {
	debugId = "profiles-dialog";

	#deps: ProfilesDialogDeps<M>;
	#tui: TUI;
	#theme: Theme;
	#focusedSelectListTheme: SelectListTheme;
	#unfocusedSelectListTheme: SelectListTheme;

	#mode: Mode = "browse";
	#panel: Panel = "profiles";
	#searchQuery = "";
	#sidebarIndex = 0;
	#profileOrder: string[] = [];
	#selectedRole: string | undefined;
	#busy = false;
	#busyLabel = "";
	#error: string | undefined;
	#notice: string | undefined;
	#pending: Promise<unknown> | null = null;

	#detailList: SelectList;

	#renameInput = new Input();
	#renameError: string | undefined;
	#renameProfileId: string | undefined;

	#createInput = new Input();
	#createError: string | undefined;
	#createSuggestedName: string | undefined;

	#deleteProfileId: string | undefined;

	#pickProfileId: string | undefined;
	#pickRole: string | undefined;
	#pickModelBrowser: ModelBrowser | undefined;
	#pickOriginalSelector: string | undefined;
	#pickResolvedSelector: string | undefined;
	#pickEffortList: SelectList | undefined;
	#pickPendingModelSelector: string | undefined;

	#disposed = false;

	constructor(tui: TUI, theme: Theme, deps: ProfilesDialogDeps<M>) {
		this.#tui = tui;
		this.#theme = theme;
		setThemeInstance(theme);
		this.#focusedSelectListTheme = makeSelectListTheme(theme, true);
		this.#unfocusedSelectListTheme = makeSelectListTheme(theme, false);
		this.#deps = deps;
		this.#profileOrder = this.#sortProfiles(this.#deps.store.profiles).map(profile => profile.id);
		this.#renameInput.prompt = "";
		this.#renameInput.onSubmit = value => void this.#commitRename(value);
		this.#renameInput.onEscape = () => this.#cancelRename();
		this.#createInput.prompt = "";
		this.#createInput.onSubmit = value => void this.#commitCreate(value);
		this.#createInput.onEscape = () => this.#cancelCreate();

		this.#detailList = this.#emptyList();
		const activeIndex = this.#orderedProfiles.findIndex(profile =>
			isProfileActive(profile, this.#deps.settings, this.#storage()),
		);
		if (activeIndex >= 0) this.#sidebarIndex = activeIndex;
		this.#normalizeSidebar();
	}

	// ────────────────────────────────────────────────────────────────────────
	// TUI interface
	// ────────────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		void this.processInput(data);
	}

	/** Public async twin of `handleInput` so tests can await a full interaction. */
	async processInput(data: string): Promise<void> {
		if (this.#disposed) return;
		if (this.#busy) {
			await this.#pending;
			return;
		}

		switch (this.#mode) {
			case "browse":
				await this.#handleBrowseInput(data);
				break;
			case "search-profiles":
				this.#handleSearchInput(data);
				break;
			case "rename":
				this.#renameInput.handleInput(data);
				break;
			case "create-profile":
				this.#createInput.handleInput(data);
				break;
			case "confirm-delete":
				await this.#handleDeleteInput(data);
				break;
			case "pick-model":
				this.#handlePickModelInput(data);
				break;
			case "pick-effort":
				this.#pickEffortList?.handleInput(data);
				break;
		}

		await this.#pending;
	}

	dispose(): void {
		this.#disposed = true;
		this.#pickModelBrowser = undefined;
		this.#pickEffortList = undefined;
	}

	debugState(): Record<string, unknown> {
		const profile = this.#currentProfile;
		return {
			mode: this.#mode,
			panel: this.#panel,
			busy: this.#busy,
			error: this.#error ?? null,
			notice: this.#notice ?? null,
			searchQuery: this.#searchQuery,
			profiles: this.#deps.store.profiles.map(p => p.name),
			filteredProfileNames: this.#filteredProfiles.map(p => p.name),
			selectedProfile: profile?.name ?? null,
			selectedRole: this.#selectedRole ?? null,
			roles: this.#currentRoles,
			renameValue: this.#renameInput.getValue(),
			renameError: this.#renameError ?? null,
			createValue: this.#createInput.getValue(),
			createError: this.#createError ?? null,
			pickModel: this.#pickModelBrowser
				? {
					query: this.#pickModelBrowser.query,
					filteredItemCount: this.#pickModelBrowser.visibleCount,
					selectedItemLabel: this.#pickModelBrowser.getSelected()?.selector ?? null,
					currentSelector: this.#pickOriginalSelector ?? null,
					resolvedCurrentSelector: this.#pickResolvedSelector ?? null,
				}
				: null,
			pickEffort: this.#pickEffortList?.debugState() ?? null,
		};
	}

	// ────────────────────────────────────────────────────────────────────────
	// Rendering
	// ────────────────────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		switch (this.#mode) {
			case "pick-model":
				return this.#renderPickModel(width);
			case "pick-effort":
				return this.#renderPickEffort(width);
			case "rename":
				return this.#renderRename(width);
			case "create-profile":
				return this.#renderCreateProfile(width);
			case "confirm-delete":
				return this.#renderConfirmDelete(width);
			default:
				return this.#renderBrowse(width);
		}
	}

	#bodyRows(): number {
		const chrome = 4 + (this.#statusText() ? 1 : 0);
		return Math.max(MIN_LIST_ROWS, this.#tui.terminal.rows - chrome);
	}

	#sidebarWidth(width: number): number {
		return Math.max(16, Math.floor(width / 3));
	}

	#title(): string {
		const parts = ["Model Profiles"];
		const profile = this.#currentProfile;
		if (profile) parts.push(profile.name);
		const query = this.#searchQuery.trim();
		if (query) parts.push(`"${query}"`);
		return parts.join(" · ");
	}

	#renderBrowse(width: number): string[] {
		const bodyRows = this.#bodyRows();
		const wide = width >= WIDE_MIN_COLUMNS;
		const out: string[] = [];

		if (wide) {
			const sidebarWidth = this.#sidebarWidth(width);
			const sidebar = this.#renderSidebarWindow(sidebarWidth, bodyRows);
			const detail = this.#renderDetailWindow(splitBodyWidth(width, sidebarWidth), bodyRows);
			out.push(topBorderSplit(this.#theme, width, this.#title(), sidebarWidth));
			for (let i = 0; i < bodyRows; i++) {
				out.push(splitRow(this.#theme, sidebar[i] ?? "", detail[i] ?? "", width, sidebarWidth));
			}
			out.push(dividerSplit(this.#theme, width, sidebarWidth));
		} else {
			const inner = Math.max(1, width - 4);
			const lines =
				this.#panel === "profiles"
					? this.#renderSidebarWindow(inner, bodyRows)
					: this.#renderDetailWindow(inner, bodyRows);
			out.push(topBorder(this.#theme, width, this.#title()));
			for (let i = 0; i < bodyRows; i++) out.push(row(this.#theme, lines[i] ?? "", width));
			out.push(divider(this.#theme, width));
		}

		const status = this.#statusText();
		if (status) out.push(row(this.#theme, this.#theme.fg(status.color, status.text), width));
		out.push(row(this.#theme, this.#theme.fg("dim", this.#footerText()), width));
		out.push(bottomBorder(this.#theme, width));
		return out;
	}

	#sidebarVisualRows(): number {
		const profileCount = this.#filteredProfiles.length;
		return profileCount + (profileCount > 0 ? 1 : 0) + 1;
	}

	#sidebarSelectedVisualIndex(): number {
		const profileCount = this.#filteredProfiles.length;
		return this.#sidebarIndex < profileCount
			? this.#sidebarIndex
			: profileCount + (profileCount > 0 ? 1 : 0);
	}

	#renderSidebarWindow(inner: number, rows: number): string[] {
		const profiles = this.#filteredProfiles;
		const profileCount = profiles.length;
		const totalRows = this.#sidebarVisualRows();
		const selectedRow = this.#sidebarSelectedVisualIndex();
		const maxStart = Math.max(0, totalRows - rows);
		const start = Math.max(0, Math.min(maxStart, selectedRow - Math.floor(rows / 2)));
		const end = Math.min(totalRows, start + rows);
		const focused = this.#panel === "profiles";
		const out: string[] = [];

		for (let visualRow = start; visualRow < end; visualRow++) {
			if (visualRow < profileCount) {
				const profile = profiles[visualRow];
				if (profile) {
					out.push(this.#renderSidebarProfileRow(profile, inner, visualRow === this.#sidebarIndex, focused));
				}
				continue;
			}
			if (profileCount > 0 && visualRow === profileCount) {
				out.push(this.#renderSidebarSeparator(inner));
				continue;
			}
			out.push(this.#renderSidebarCreateRow(inner, this.#sidebarIndex === profileCount, focused));
		}

		return this.#padLines(out, rows);
	}

	#renderSidebarProfileRow(profile: ModelProfile, width: number, selected: boolean, focused: boolean): string {
		const cursorGlyph = this.#theme.nav.cursor || ">";
		const activeGlyph = this.#theme.status.success || "✓";
		const cursorWidth = Math.max(1, visibleWidth(cursorGlyph));
		const activeWidth = Math.max(1, visibleWidth(activeGlyph));
		const active = isProfileActive(profile, this.#deps.settings, this.#storage());
		const focusedSelection = selected && focused;
		const badge = "ACTIVE";
		const showBadge = active && width >= cursorWidth + activeWidth + visibleWidth(badge) + 6;
		const prefixWidth = cursorWidth + activeWidth + 2;
		const nameWidth = Math.max(1, width - prefixWidth - (showBadge ? visibleWidth(badge) + 2 : 0));

		const cursor = fit(focusedSelection ? cursorGlyph : "", cursorWidth);
		const marker = fit(active ? activeGlyph : "", activeWidth);
		const name = fit(profile.name, nameWidth);
		const styledName = active
			? this.#theme.bold(selected ? this.#theme.fg("accent", name) : name)
			: selected
				? this.#theme.fg("accent", name)
				: name;
		const styledBadge = showBadge ? this.#theme.fg("success", this.#theme.bold(badge)) : "";
		const line = fit(
			`${this.#theme.fg("accent", cursor)} ${this.#theme.fg("success", marker)} ${styledName}${showBadge ? `  ${styledBadge}` : ""}`,
			width,
		);

		return focusedSelection ? this.#theme.bg("selectedBg", line) : line;
	}

	#renderSidebarSeparator(width: number): string {
		return fit(this.#theme.fg("borderMuted", this.#theme.boxSharp.horizontal.repeat(Math.max(0, width))), width);
	}

	#renderSidebarCreateRow(width: number, selected: boolean, focused: boolean): string {
		const cursorGlyph = this.#theme.nav.cursor || ">";
		const cursorWidth = Math.max(1, visibleWidth(cursorGlyph));
		const icon = this.#theme.symbol("cmd.plus") || "+";
		const focusedSelection = selected && focused;
		const cursor = fit(focusedSelection ? cursorGlyph : "", cursorWidth);
		const labelWidth = Math.max(1, width - cursorWidth - 1);
		const label = fit(`[ ${icon} New profile ]`, labelWidth);
		const line = fit(
			`${this.#theme.fg("accent", cursor)} ${this.#theme.fg("accent", label)}`,
			width,
		);

		return focusedSelection ? this.#theme.bg("selectedBg", line) : line;
	}

	#renderDetailWindow(inner: number, rows: number): string[] {
		if (!this.#currentProfile) {
			return this.#hintWindow("Create or select a profile to snapshot the current model roles", rows);
		}
		if (this.#currentRoles.length === 0) {
			return this.#hintWindow("No roles configured", rows);
		}
		this.#detailList.setMaxVisible(rows);
		return this.#padLines(this.#detailList.render(inner), rows);
	}

	#hintWindow(text: string, rows: number): string[] {
		const lines: string[] = [this.#theme.fg("muted", text)];
		for (let i = 1; i < rows; i++) lines.push("");
		return lines;
	}

	#padLines(lines: readonly string[], rows: number): string[] {
		const out: string[] = [];
		for (let i = 0; i < rows; i++) out.push(lines[i] ?? "");
		return out;
	}

	#statusText(): StatusText | null {
		if (this.#busy) return { text: this.#busyLabel, color: "accent" };
		if (this.#error) return { text: this.#error, color: "error" };
		if (this.#notice) return { text: this.#notice, color: "success" };
		return null;
	}

	#footerText(): string {
		switch (this.#mode) {
			case "search-profiles":
				return "Enter done · Esc clear";
			case "rename":
				return "Enter save · Esc cancel";
			case "create-profile":
				return "Enter create · Esc cancel";
			case "confirm-delete":
				return "Enter delete · Esc cancel";
			case "pick-model":
				return "↑/↓ models · Enter assign · type to search · Delete Auto · Esc back";
			case "pick-effort":
				return "↑/↓ effort · Enter assign · Esc models";
			case "browse":
				if (this.#panel === "details") return "Enter pick · Tab profiles · Esc close";
				if (!this.#currentProfile) return "Enter create · / search · Esc close";
				return "Enter apply · n create · e rename · d delete · / search · Tab details · Esc close";
		}
	}

	#renderRename(width: number): string[] {
		const profile = this.#profileById(this.#renameProfileId);
		const inner = Math.max(1, width - 4);
		const out: string[] = [];
		out.push(topBorder(this.#theme, width, "Rename Profile"));
		out.push(row(this.#theme, this.#theme.fg("muted", `Rename "${profile?.name ?? ""}" to:`), width));
		for (const line of this.#renameInput.render(inner)) out.push(row(this.#theme, line, width));
		if (this.#renameError) out.push(row(this.#theme, this.#theme.fg("error", this.#renameError), width));
		out.push(divider(this.#theme, width));
		out.push(row(this.#theme, this.#theme.fg("dim", this.#footerText()), width));
		out.push(bottomBorder(this.#theme, width));
		return out;
	}

	#renderCreateProfile(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const out: string[] = [];
		out.push(topBorder(this.#theme, width, "Create Profile"));
		out.push(
			row(this.#theme, this.#theme.fg("muted", `Name (Enter for "${this.#createSuggestedName ?? ""}"):`), width),
		);
		for (const line of this.#createInput.render(inner)) out.push(row(this.#theme, line, width));
		if (this.#createError) out.push(row(this.#theme, this.#theme.fg("error", this.#createError), width));
		out.push(divider(this.#theme, width));
		out.push(row(this.#theme, this.#theme.fg("dim", this.#footerText()), width));
		out.push(bottomBorder(this.#theme, width));
		return out;
	}

	#renderConfirmDelete(width: number): string[] {
		const profile = this.#profileById(this.#deleteProfileId);
		const out: string[] = [];
		out.push(topBorder(this.#theme, width, "Delete Profile"));
		out.push(
			row(
				this.#theme,
				this.#theme.fg("muted", `Delete "${profile?.name ?? ""}"? Applied role settings are not reverted.`),
				width,
			),
		);
		out.push(divider(this.#theme, width));
		out.push(row(this.#theme, this.#theme.fg("dim", this.#footerText()), width));
		out.push(bottomBorder(this.#theme, width));
		return out;
	}

	#renderPickModel(width: number): string[] {
		const role = this.#pickRole ?? "";
		const inner = Math.max(1, width - 4);
		const out: string[] = [];
		out.push(topBorder(this.#theme, width, `Pick Model · ${roleDisplayName(role, this.#deps.settings)}`));

		const status = this.#pickModelStatus();
		out.push(row(this.#theme, this.#theme.fg(status.color, ` ${status.text}`), width));

		const browser = this.#pickModelBrowser;
		if (browser) {
			browser.setMaxVisible(Math.max(MIN_LIST_ROWS, this.#tui.terminal.rows - 9));
			for (const line of browser.render(inner)) out.push(row(this.#theme, line, width));
		}

		out.push(row(this.#theme, this.#theme.fg("dim", this.#footerText()), width));
		out.push(bottomBorder(this.#theme, width));
		return out;
	}
	#renderPickEffort(width: number): string[] {
		const role = this.#pickRole ?? "";
		const inner = Math.max(1, width - 4);
		const out: string[] = [];
		out.push(topBorder(this.#theme, width, `Pick Reasoning Effort · ${roleDisplayName(role, this.#deps.settings)}`));
		out.push(
			row(
				this.#theme,
				this.#theme.fg("muted", `Model: ${this.#pickPendingModelSelector ?? ""}`),
				width,
			),
		);
		const list = this.#pickEffortList;
		if (list) {
			list.setMaxVisible(8);
			for (const line of list.render(inner)) out.push(row(this.#theme, line, width));
		}
		const status = this.#statusText();
		if (status) out.push(row(this.#theme, this.#theme.fg(status.color, status.text), width));
		out.push(divider(this.#theme, width));
		out.push(row(this.#theme, this.#theme.fg("dim", this.#footerText()), width));
		out.push(bottomBorder(this.#theme, width));
		return out;
	}


	#pickModelStatus(): StatusText {
		if (this.#busy) return { text: this.#busyLabel, color: "accent" };
		if (this.#error) return { text: this.#error, color: "error" };
		if (!this.#pickOriginalSelector) return { text: "Current assignment: Auto", color: "muted" };
		if (!this.#pickResolvedSelector) {
			return { text: `Saved selector is not currently available: ${this.#pickOriginalSelector}`, color: "warning" };
		}
		return { text: `Current assignment: ${this.#pickOriginalSelector}`, color: "muted" };
	}

	// ────────────────────────────────────────────────────────────────────────
	// Input handling
	// ────────────────────────────────────────────────────────────────────────

	#handleSidebarNavigation(data: string): boolean {
		const items = this.#sidebarItems;
		if (items.length === 0) return false;

		let nextIndex: number | undefined;
		if (matchesKey(data, "up")) {
			nextIndex = this.#sidebarIndex === 0 ? items.length - 1 : this.#sidebarIndex - 1;
		} else if (matchesKey(data, "down")) {
			nextIndex = this.#sidebarIndex === items.length - 1 ? 0 : this.#sidebarIndex + 1;
		} else if (matchesKey(data, "pageUp")) {
			nextIndex = Math.max(0, this.#sidebarIndex - this.#bodyRows());
		} else if (matchesKey(data, "pageDown")) {
			nextIndex = Math.min(items.length - 1, this.#sidebarIndex + this.#bodyRows());
		}

		if (nextIndex === undefined) return false;
		if (nextIndex !== this.#sidebarIndex) {
			this.#sidebarIndex = nextIndex;
			this.#selectRoleForProfile();
			this.#rebuildDetailList();
			this.#tui.requestRender();
		}
		return true;
	}

	#selectedSidebarValue(): string {
		const item = this.#sidebarItems[this.#sidebarIndex];
		return item?.kind === "profile" ? item.profile.id : CREATE_VALUE;
	}

	async #handleBrowseInput(data: string): Promise<void> {
		if (isEscape(data)) {
			this.#deps.done();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (this.#panel === "profiles" && !this.#currentProfile) return;
			this.#panel = this.#panel === "profiles" ? "details" : "profiles";
			this.#rebuildLists();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#panel !== "profiles") {
				this.#panel = "profiles";
				this.#rebuildLists();
				this.#tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "right")) {
			if (this.#panel !== "details" && this.#currentProfile) {
				this.#panel = "details";
				this.#rebuildLists();
				this.#tui.requestRender();
			}
			return;
		}
		if (data === "/" && this.#panel === "profiles") {
			this.#mode = "search-profiles";
			this.#tui.requestRender();
			return;
		}
		if (isEnter(data)) {
			if (this.#panel === "profiles") await this.#activateSidebar(this.#selectedSidebarValue());
			else this.#detailList.handleInput(data);
			return;
		}
		if (data === "n") {
			this.#beginCreate();
			return;
		}
		if (data === "e") {
			this.#beginRename();
			return;
		}
		if (data === "d") {
			this.#beginDelete();
			return;
		}
		if (this.#panel === "profiles") this.#handleSidebarNavigation(data);
		else this.#detailList.handleInput(data);
	}

	#handleSearchInput(data: string): void {
		if (isEscape(data)) {
			this.#searchQuery = "";
			this.#mode = "browse";
			this.#panel = "profiles";
			this.#normalizeSidebar();
			return;
		}
		if (isEnter(data)) {
			this.#mode = "browse";
			this.#panel = "profiles";
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = [...this.#searchQuery].slice(0, -1).join("");
				this.#normalizeSidebar();
			}
			return;
		}
		const text = extractPrintableText(data);
		if (text === undefined) return;
		if (this.#searchQuery.length === 0 && text.trim().length === 0) return;
		this.#searchQuery += text;
		this.#normalizeSidebar();
	}

	async #handleDeleteInput(data: string): Promise<void> {
		if (isEscape(data)) {
			this.#deleteProfileId = undefined;
			this.#mode = "browse";
			return;
		}
		if (isEnter(data)) {
			await this.#confirmDelete();
		}
	}

	// ────────────────────────────────────────────────────────────────────────
	// Actions
	// ────────────────────────────────────────────────────────────────────────

	async #activateSidebar(value: string): Promise<void> {
		if (value === CREATE_VALUE) {
			this.#beginCreate();
			return;
		}
		const profile = this.#profileById(value);
		if (profile) await this.#applyProfile(profile);
	}

	#beginCreate(): void {
		this.#createSuggestedName = nextFreeName(this.#deps.store.profiles);
		this.#createError = undefined;
		this.#createInput.setValue("");
		this.#createInput.focused = true;
		this.#mode = "create-profile";
	}

	async #commitCreate(value: string): Promise<void> {
		const trimmed = value.trim();
		const name = trimmed.length > 0 ? trimmed : this.#createSuggestedName;
		if (!name) return;
		const profile = await this.#runAction(
			"Saving…",
			() => this.#deps.store.create(snapshotModelRoles(this.#deps.settings), name),
			error => {
				this.#createError = error.message;
			},
		);
		if (!profile) return;
		this.#profileOrder.push(profile.id);
		this.#createInput.focused = false;
		this.#createError = undefined;
		this.#createSuggestedName = undefined;
		this.#mode = "browse";
		this.#notice = `Created ${profile.name}`;
		const index = this.#filteredProfiles.findIndex(p => p.id === profile.id);
		if (index >= 0) this.#sidebarIndex = index;
		this.#selectedRole = undefined;
		this.#normalizeSidebar();
	}

	#cancelCreate(): void {
		this.#createInput.focused = false;
		this.#createError = undefined;
		this.#createSuggestedName = undefined;
		this.#mode = "browse";
	}

	async #applyProfile(profile: ModelProfile): Promise<void> {
		const outcome = await this.#runAction("Applying…", async () => {
			const result = await applyProfile(profile, this.#deps.settings, this.#deps.models, this.#deps.pi);
			if (result.ok) await this.#deps.store.markUsed(profile.id);
			return result;
		});
		if (!outcome) return;
		if (!outcome.ok) {
			this.#error = `Unavailable: ${outcome.unavailableRoles.join(", ")}`;
			return;
		}
		this.#notice = outcome.warning ?? `Applied ${profile.name} (${outcome.storage})`;
		this.#selectSidebarProfile(profile.id);
	}

	#beginRename(): void {
		const profile = this.#currentProfile;
		if (!profile) return;
		this.#renameProfileId = profile.id;
		this.#renameError = undefined;
		this.#renameInput.setValue(profile.name);
		this.#renameInput.focused = true;
		this.#mode = "rename";
	}

	async #commitRename(value: string): Promise<void> {
		const id = this.#renameProfileId;
		if (!id) return;
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			this.#renameError = "Name must not be empty";
			return;
		}
		const profile = await this.#runAction(
			"Saving…",
			() => this.#deps.store.rename(id, trimmed),
			error => {
				this.#renameError = error.message;
			},
		);
		if (!profile) return;
		this.#renameInput.focused = false;
		this.#renameProfileId = undefined;
		this.#renameError = undefined;
		this.#mode = "browse";
		this.#notice = `Renamed to ${profile.name}`;
		this.#normalizeSidebar();
	}

	#cancelRename(): void {
		this.#renameInput.focused = false;
		this.#renameProfileId = undefined;
		this.#renameError = undefined;
		this.#mode = "browse";
	}

	#beginDelete(): void {
		const profile = this.#currentProfile;
		if (!profile) return;
		this.#deleteProfileId = profile.id;
		this.#mode = "confirm-delete";
	}

	async #confirmDelete(): Promise<void> {
		const id = this.#deleteProfileId;
		if (!id) return;
		const removed = await this.#runAction("Deleting…", async () => {
			await this.#deps.store.remove(id);
			return true;
		});
		if (removed === undefined) return;
		this.#profileOrder = this.#profileOrder.filter(profileId => profileId !== id);
		this.#deleteProfileId = undefined;
		this.#mode = "browse";
		this.#notice = "Profile deleted";
		this.#normalizeSidebar();
	}

	#openPickModel(role: string): void {
		const profile = this.#currentProfile;
		if (!profile) return;
		this.#pickProfileId = profile.id;
		this.#pickRole = role;
		this.#error = undefined;
		this.#notice = undefined;

		const models = [...this.#deps.models.list()];
		const items = buildBrowserItems(models);
		sortModelItems(items);

		const currentSelector = profile.models[role];
		const currentModel = currentSelector ? this.#deps.models.resolve(currentSelector) : undefined;
		const currentBaseSelector = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
		const resolvedSelector = currentBaseSelector && items.some(item => item.selector === currentBaseSelector)
			? currentBaseSelector
			: undefined;
		this.#pickOriginalSelector = currentSelector;
		this.#pickResolvedSelector = resolvedSelector;

		const browser = new ModelBrowser(this.#deps.settings, {
			showProvider: true,
			markOverContext: false,
			emptyText: () => "  No authenticated models available",
		});
		browser.setCurrentSelector(resolvedSelector);
		browser.setItems(items);
		browser.setFocused(true);
		if (resolvedSelector) browser.selectSelector(resolvedSelector);
		browser.onActivate = item => this.#choosePickModel(item);
		browser.onCancel = () => this.#closePickModel();
		this.#pickModelBrowser = browser;
		this.#mode = "pick-model";
	}

	#handlePickModelInput(data: string): void {
		const browser = this.#pickModelBrowser;
		if (!browser) return;
		if (browser.query.length === 0 && matchesKey(data, "delete")) {
			void this.#savePickedSelector(undefined);
			return;
		}
		browser.handleInput(data);
	}

	#choosePickModel(item: ModelBrowserItem): void {
		const efforts = item.model.reasoning ? (item.model.thinking?.efforts ?? []) : [];
		if (efforts.length === 0) {
			void this.#savePickedSelector(item.selector);
			return;
		}
		this.#openEffortPicker(item, efforts);
	}

	#openEffortPicker(item: ModelBrowserItem, efforts: readonly PickerEffort[]): void {
		this.#pickPendingModelSelector = item.selector;
		const selectItems: SelectItem[] = [
			{
				value: DEFAULT_EFFORT_VALUE,
				label: "default",
				description: "Use the model default (no explicit effort suffix)",
			},
			...efforts.map(effort => {
				const metadata = getThinkingLevelMetadata(effort);
				return { value: effort, label: metadata.label, description: metadata.description };
			}),
		];
		const list = new SelectList(selectItems, selectItems.length, this.#focusedSelectListTheme, {
			overflowSearch: false,
		});

		let selectedEffort = item.model.thinking?.defaultLevel;
		if (item.selector === this.#pickResolvedSelector && this.#pickOriginalSelector) {
			const parsed = parseModelString(this.#pickOriginalSelector, {
				allowMaxSuffix: true,
				isLiteralModelId: (provider, id) => provider === item.model.provider && id === item.model.id,
			});
			selectedEffort = efforts.find(effort => effort === parsed?.thinkingLevel) ?? selectedEffort;
		}
		const selectedIndex = selectedEffort
			? selectItems.findIndex(selectItem => selectItem.value === selectedEffort)
			: 0;
		list.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
		list.onSelect = selectItem => void this.#commitPickEffort(selectItem.value);
		list.onCancel = () => {
			this.#pickEffortList = undefined;
			this.#pickPendingModelSelector = undefined;
			this.#mode = "pick-model";
			this.#tui.requestRender();
		};
		this.#pickEffortList = list;
		this.#mode = "pick-effort";
	}

	async #commitPickEffort(effort: string): Promise<void> {
		const modelSelector = this.#pickPendingModelSelector;
		if (!modelSelector) return;
		const selector = effort === DEFAULT_EFFORT_VALUE ? modelSelector : `${modelSelector}:${effort}`;
		await this.#savePickedSelector(selector);
	}

	async #savePickedSelector(selector: string | undefined): Promise<void> {
		const profileId = this.#pickProfileId;
		const role = this.#pickRole;
		if (!profileId || !role) return;
		const profile = await this.#runAction("Saving…", () => this.#deps.store.setModel(profileId, role, selector));
		if (!profile) return;
		this.#closePickModel();
		this.#selectedRole = role;
		this.#notice = `Updated ${roleDisplayName(role, this.#deps.settings)}`;
		this.#normalizeSidebar();
	}

	#closePickModel(): void {
		this.#pickProfileId = undefined;
		this.#pickRole = undefined;
		this.#pickModelBrowser = undefined;
		this.#pickOriginalSelector = undefined;
		this.#pickEffortList = undefined;
		this.#pickPendingModelSelector = undefined;
		this.#pickResolvedSelector = undefined;
		this.#mode = "browse";
		this.#tui.requestRender();
	}

	// ────────────────────────────────────────────────────────────────────────
	// Helpers
	// ────────────────────────────────────────────────────────────────────────

	#emptyList(): SelectList {
		return new SelectList([], 1, this.#unfocusedSelectListTheme, { overflowSearch: false });
	}

	#rebuildLists(): void {
		this.#rebuildDetailList();
	}

	#rebuildDetailList(): void {
		const profile = this.#currentProfile;
		const roles = this.#currentRoles;
		const items: SelectItem[] = roles.map(role => ({
			value: role,
			label: roleTag(role, this.#deps.settings) ?? role,
			description: this.#roleDescription(profile, role),
		}));

		const list = new SelectList(
			items,
			Math.max(1, this.#tui.terminal.rows),
			this.#panel === "details" ? this.#focusedSelectListTheme : this.#unfocusedSelectListTheme,
			{ overflowSearch: false },
		);
		if (items.length > 0) list.setSelectedIndex(clamp(this.#rolesIndex(), 0, items.length - 1));
		list.onSelectionChange = item => {
			this.#selectedRole = item.value;
			this.#tui.requestRender();
		};
		list.onSelect = item => void this.#openPickModel(item.value);
		this.#detailList = list;
	}

	#roleDescription(profile: ModelProfile | undefined, role: string): string {
		const selector = profile?.models[role];
		return selector ?? "Auto";
	}

	#runAction<T>(
		label: string,
		action: () => Promise<T>,
		onError?: (error: Error) => void,
	): Promise<T | undefined> {
		this.#busy = true;
		this.#busyLabel = label;
		this.#error = undefined;
		this.#notice = undefined;
		this.#tui.requestRender();

		const run = (async () => {
			try {
				return await action();
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				this.#error = err.message;
				onError?.(err);
				return undefined;
			} finally {
				this.#busy = false;
				this.#busyLabel = "";
				this.#tui.requestRender();
			}
		})();

		this.#pending = run;
		return run;
	}

	#storage(): "global" | "project" {
		return this.#deps.settings.get("modelRoleStorage") === "project" ? "project" : "global";
	}

	#sortProfiles(profiles: readonly ModelProfile[]): ModelProfile[] {
		return profiles
			.map((profile, index) => ({ profile, index }))
			.sort((a, b) => {
				if (a.profile.lastUsedAt === undefined) return b.profile.lastUsedAt === undefined ? a.index - b.index : 1;
				if (b.profile.lastUsedAt === undefined) return -1;
				return b.profile.lastUsedAt - a.profile.lastUsedAt || a.index - b.index;
			})
			.map(entry => entry.profile);
	}

	get #orderedProfiles(): ModelProfile[] {
		const currentById = new Map(this.#deps.store.profiles.map(profile => [profile.id, profile]));
		const ordered: ModelProfile[] = [];
		const included = new Set<string>();
		for (const id of this.#profileOrder) {
			const profile = currentById.get(id);
			if (!profile || included.has(id)) continue;
			ordered.push(profile);
			included.add(id);
		}
		for (const profile of this.#deps.store.profiles) {
			if (included.has(profile.id)) continue;
			ordered.push(profile);
			included.add(profile.id);
		}
		return ordered;
	}

	get #filteredProfiles(): ModelProfile[] {
		const query = this.#searchQuery.trim().toLowerCase();
		const profiles = this.#orderedProfiles;
		if (!query) return profiles;
		return profiles.filter(profile => profile.name.toLowerCase().includes(query));
	}

	get #sidebarItems(): SidebarItem[] {
		const items: SidebarItem[] = this.#filteredProfiles.map(profile => ({ kind: "profile", profile }));
		items.push({ kind: "create" });
		return items;
	}

	get #currentProfile(): ModelProfile | undefined {
		const item = this.#sidebarItems[this.#sidebarIndex];
		return item?.kind === "profile" ? item.profile : undefined;
	}


	get #currentRoles(): string[] {
		const profile = this.#currentProfile;
		return profile ? orderedRoleIds(this.#deps.settings, profile.models) : [];
	}

	#rolesIndex(): number {
		const roles = this.#currentRoles;
		if (roles.length === 0) return 0;
		if (!this.#selectedRole) return 0;
		const index = roles.indexOf(this.#selectedRole);
		return index === -1 ? 0 : index;
	}

	#selectSidebarProfile(id: string): void {
		const items = this.#sidebarItems;
		const index = items.findIndex(item => item.kind === "profile" && item.profile.id === id);
		this.#sidebarIndex = index >= 0 ? index : clamp(this.#sidebarIndex, 0, Math.max(0, items.length - 1));
		this.#selectRoleForProfile();
		this.#rebuildLists();
	}

	#normalizeSidebar(): void {
		const items = this.#sidebarItems;
		const current = items[this.#sidebarIndex];
		const currentId = current?.kind === "profile" ? current.profile.id : undefined;
		if (currentId) {
			const index = items.findIndex(item => item.kind === "profile" && item.profile.id === currentId);
			this.#sidebarIndex = index >= 0 ? index : clamp(0, 0, items.length - 1);
		} else {
			this.#sidebarIndex = clamp(this.#sidebarIndex, 0, Math.max(0, items.length - 1));
		}
		this.#selectRoleForProfile();
		this.#rebuildLists();
	}

	#selectRoleForProfile(): void {
		const roles = this.#currentRoles;
		if (!this.#selectedRole || !roles.includes(this.#selectedRole)) {
			this.#selectedRole = roles[0];
		}
	}

	#profileById(id: string | undefined): ModelProfile | undefined {
		if (!id) return undefined;
		return this.#deps.store.profiles.find(profile => profile.id === id);
	}
}
