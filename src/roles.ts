import { getKnownRoleIds, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/**
 * Ordered role ids for a profile's detail list: runtime-known roles first
 * (built-ins, `cycleOrder`, configured roles, model tags), then profile-only
 * roles that OMP does not know about yet. Never mirrors a role enum.
 */
export function orderedRoleIds(settings: Settings, profileModels: Record<string, string>): string[] {
	const ids = getKnownRoleIds(settings);
	const seen = new Set(ids);
	for (const role of Object.keys(profileModels)) {
		if (!seen.has(role)) {
			seen.add(role);
			ids.push(role);
		}
	}
	return ids;
}

/** Display name for a role, resolved through OMP (built-in or custom). */
export function roleDisplayName(role: string, settings: Settings): string {
	return getRoleInfo(role, settings).name;
}

/** Optional short tag for a role, resolved through OMP. */
export function roleTag(role: string, settings: Settings): string | undefined {
	return getRoleInfo(role, settings).tag;
}

/** Exact effective role selectors, including custom roles and thinking suffixes. */
export function snapshotModelRoles(settings: Settings): Record<string, string> {
	const snapshot: Record<string, string> = {};
	for (const [role, selector] of Object.entries(settings.getModelRoles())) {
		if (selector !== undefined) snapshot[role] = selector;
	}
	return snapshot;
}
