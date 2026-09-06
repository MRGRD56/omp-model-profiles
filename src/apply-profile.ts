import { parseModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import type { ModelProfile } from "./profile-store";
import { orderedRoleIds } from "./roles";

/** A thinking selector excluding the `auto` sentinel (what `setThinkingLevel` accepts). */
export type ConcreteThinkingLevel = Exclude<ConfiguredThinkingLevel, typeof AUTO_THINKING>;

/** Minimal resolved-model shape needed to display and switch a model. */
export interface ModelRef {
	provider: string;
	id: string;
}

export interface ApplyModels<M extends ModelRef = ModelRef> {
	resolve(spec: string): M | undefined;
}

export interface ApplySession<M extends ModelRef = ModelRef> {
	setModel(model: M): Promise<boolean>;
	setThinkingLevel(level: ConcreteThinkingLevel): void;
}

export interface ApplyOutcome {
	storage: "global" | "project";
	ok: boolean;
	unavailableRoles: string[];
	switchedDefault: boolean;
	defaultModel?: string;
	warning?: string;
}

function storageMode(settings: Settings): "global" | "project" {
	return settings.get("modelRoleStorage") === "project" ? "project" : "global";
}

/**
 * Apply a profile as the complete role-assignment set for the configured
 * storage layer, then switch the live session to the effective default model.
 *
 * Any unresolved selector aborts the whole operation before a single mutation,
 * so a broken profile can never leave the settings half-applied.
 */
export async function applyProfile<M extends ModelRef = ModelRef>(
	profile: ModelProfile,
	settings: Settings,
	models: ApplyModels<M>,
	session: ApplySession<M>,
): Promise<ApplyOutcome> {
	const storage = storageMode(settings);

	const unavailable: string[] = [];
	for (const [role, selector] of Object.entries(profile.models)) {
		if (selector.length > 0 && !models.resolve(selector)) {
			unavailable.push(role);
		}
	}
	if (unavailable.length > 0) {
		return { storage, ok: false, unavailableRoles: unavailable, switchedDefault: false };
	}

	if (storage === "global") {
		settings.set("modelRoles", structuredClone(profile.models));
	} else {
		// No whole-project setter exists in OMP; clear stale project roles and
		// set the profile's own keys, so previous assignments never survive a
		// profile switch.
		for (const role of orderedRoleIds(settings, profile.models)) {
			const value = profile.models[role];
			if (value !== undefined && value.length > 0) {
				settings.setProjectModelRole(role, value);
			} else {
				settings.clearProjectModelRole(role);
			}
		}
	}

	await settings.flush();

	const defaultSelector = settings.getModelRole("default");
	let switchedDefault = false;
	let defaultModel: string | undefined;
	let warning: string | undefined;

	if (defaultSelector) {
		const model = models.resolve(defaultSelector);
		if (model) {
			const ok = await session.setModel(model);
			if (ok) {
				switchedDefault = true;
				defaultModel = `${model.provider}/${model.id}`;
				const level = parseModelString(defaultSelector)?.thinkingLevel;
				if (level !== undefined && level !== AUTO_THINKING) {
					session.setThinkingLevel(level);
				}
			} else {
				warning = "Profile saved, but the session model could not be switched";
			}
		} else {
			warning = "Profile saved, but the default model could not be resolved; session model not switched";
		}
	}

	return { storage, ok: true, unavailableRoles: [], switchedDefault, defaultModel, warning };
}

/**
 * Whether `profile` currently matches the non-empty assignments of its target
 * layer (`global` or `project`). No `activeProfileId` is persisted, so manual
 * role edits never leave a stale "active" marker behind.
 */
export function isProfileActive(
	profile: ModelProfile,
	settings: Settings,
	storage: "global" | "project",
): boolean {
	const target: Record<string, string> = {};
	for (const role of orderedRoleIds(settings, profile.models)) {
		const value = storage === "project" ? settings.getProjectModelRole(role) : settings.getGlobalModelRole(role);
		if (value) target[role] = value;
	}

	const profileKeys = Object.keys(profile.models);
	const targetKeys = Object.keys(target);
	if (profileKeys.length !== targetKeys.length) return false;
	for (const key of profileKeys) {
		if (profile.models[key] !== target[key]) return false;
	}
	return true;
}
