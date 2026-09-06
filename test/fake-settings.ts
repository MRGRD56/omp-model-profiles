import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

export interface FakeModelTag {
	name?: string;
	color?: string;
	hidden?: boolean;
}

/**
 * Structural `Settings` stand-in for tests. Implements only the surface the
 * profiles extension reads or writes, with call recording for observable
 * transitions. Cast with `as unknown as Settings` where full-typed APIs are
 * required.
 */
export class FakeSettings {
	roleStorage: "global" | "project" = "global";
	global: Record<string, string> = {};
	project: Record<string, string> = {};
	cycleOrder: string[] = [];
	modelTags: Record<string, FakeModelTag> = {};

	flushCalls = 0;
	setGlobalModelRolesCalls = 0;
	setProjectCalls: string[] = [];
	clearProjectCalls: string[] = [];

	effective(): Record<string, string> {
		return { ...this.global, ...this.project };
	}

	get(path: string): unknown {
		switch (path) {
			case "modelRoleStorage":
				return this.roleStorage;
			case "cycleOrder":
				return this.cycleOrder;
			case "modelTags":
				return this.modelTags;
			case "modelRoles":
				return this.effective();
			case "modelProviderOrder":
				return [];
			default:
				throw new Error(`FakeSettings.get(${path}) not implemented`);
		}
	}

	getModelRoles(): Record<string, string> {
		return this.effective();
	}

	getModelRole(role: string): string | undefined {
		return this.effective()[role];
	}

	getGlobalModelRole(role: string): string | undefined {
		return this.global[role];
	}

	getProjectModelRole(role: string): string | undefined {
		return this.project[role];
	}

	set(path: string, value: unknown): void {
		if (path === "modelRoles") {
			this.setGlobalModelRolesCalls++;
			this.global = { ...(value as Record<string, string>) };
			return;
		}
		throw new Error(`FakeSettings.set(${path}) not implemented`);
	}

	setProjectModelRole(role: string, value: string): void {
		this.setProjectCalls.push(role);
		this.project[role] = value;
	}

	clearProjectModelRole(role: string): void {
		this.clearProjectCalls.push(role);
		delete this.project[role];
	}

	async flush(): Promise<void> {
		this.flushCalls++;
	}
}

export function asSettings(fake: FakeSettings): Settings {
	return fake as unknown as Settings;
}
