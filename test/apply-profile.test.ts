import { describe, expect, test } from "bun:test";
import { applyProfile, type ConcreteThinkingLevel, type ModelRef } from "../src/apply-profile";
import type { ModelProfile } from "../src/profile-store";
import { asSettings, FakeSettings } from "./fake-settings";

function profile(models: Record<string, string>): ModelProfile {
	return { id: "p1", name: "P", models };
}

function resolvingModels(resolve: (spec: string) => ModelRef | undefined) {
	return { resolve };
}

function session(overrides?: {
	setModel?: (model: ModelRef) => Promise<boolean>;
	setThinkingLevel?: (level: ConcreteThinkingLevel) => void;
}) {
	const calls: ModelRef[] = [];
	let thinkingLevel: string | undefined;
	return {
		calls,
		thinkingLevel() {
			return thinkingLevel;
		},
		api: {
			setModel: overrides?.setModel ?? (async (model: ModelRef) => {
				calls.push(model);
				return true;
			}),
			setThinkingLevel: overrides?.setThinkingLevel ?? ((level: ConcreteThinkingLevel) => {
				thinkingLevel = String(level);
			}),
		},
	};
}

function providerModel(spec: string): ModelRef {
	const [provider, rawId] = spec.split("/");
	const id = (rawId ?? spec).split(":")[0] ?? "";
	return { provider: provider ?? "provider", id };
}

describe("applyProfile", () => {
	test("global mode replaces the whole map in one operation and removes stale roles", async () => {
		const fake = new FakeSettings();
		fake.roleStorage = "global";
		fake.global = { default: "provider/old", "stale-role": "provider/stale" };
		const settings = asSettings(fake);
		const models = resolvingModels(spec => providerModel(spec));
		const recorded = session();

		const outcome = await applyProfile(
			profile({ default: "provider/new", "future-role": "provider/future" }),
			settings,
			models,
			recorded.api,
		);

		expect(outcome.ok).toBe(true);
		expect(outcome.storage).toBe("global");
		expect(settings.getModelRoles()).toEqual({ default: "provider/new", "future-role": "provider/future" });
		expect(settings.getGlobalModelRole("stale-role")).toBeUndefined();
		expect(fake.flushCalls).toBe(1);
		expect(outcome.switchedDefault).toBe(true);
		expect(outcome.defaultModel).toBe("provider/new");
		expect(recorded.calls).toEqual([{ provider: "provider", id: "new" }]);
	});

	test("project mode calls only project setters/clearers and leaves global untouched", async () => {
		const fake = new FakeSettings();
		fake.roleStorage = "project";
		fake.global = { default: "provider/global-default", "stale-role": "provider/stale" };
		const settings = asSettings(fake);
		const models = resolvingModels(spec => providerModel(spec));

		const outcome = await applyProfile(
			profile({ default: "provider/new", "future-role": "provider/future" }),
			settings,
			models,
			session().api,
		);

		expect(outcome.ok).toBe(true);
		expect(outcome.storage).toBe("project");
		expect(settings.getProjectModelRole("default")).toBe("provider/new");
		expect(settings.getProjectModelRole("future-role")).toBe("provider/future");
		expect(settings.getProjectModelRole("stale-role")).toBeUndefined();
		expect(settings.getGlobalModelRole("default")).toBe("provider/global-default");
		expect(settings.getGlobalModelRole("stale-role")).toBe("provider/stale");
		expect(fake.setGlobalModelRolesCalls).toBe(0);
		expect(fake.setProjectCalls).toContain("future-role");
		expect(fake.clearProjectCalls).toContain("stale-role");
	});

	test("unknown compile-time custom role is applied", async () => {
		const settings = asSettings(Object.assign(new FakeSettings(), { roleStorage: "global" }));
		const models = resolvingModels(spec => providerModel(spec));
		const outcome = await applyProfile(
			profile({ "brand-new-role": "provider/model" }),
			settings,
			models,
			session().api,
		);
		expect(outcome.ok).toBe(true);
		expect(settings.getModelRoles()).toEqual({ "brand-new-role": "provider/model" });
	});

	test("unavailable selector aborts before any mutation", async () => {
		const fake = new FakeSettings();
		fake.roleStorage = "global";
		fake.global = { default: "provider/old", "stale-role": "provider/stale" };
		const settings = asSettings(fake);
		const models = resolvingModels(spec => (spec === "missing/model" ? undefined : providerModel(spec)));
		const recorded = session();

		const outcome = await applyProfile(
			profile({ default: "missing/model", "stale-role": "provider/keep" }),
			settings,
			models,
			recorded.api,
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.unavailableRoles).toEqual(["default"]);
		expect(settings.getModelRoles()).toEqual({ default: "provider/old", "stale-role": "provider/stale" });
		expect(fake.flushCalls).toBe(0);
		expect(recorded.calls).toHaveLength(0);
	});

	test("successful apply flushes and switches the live session to the resolved default", async () => {
		const settings = asSettings(Object.assign(new FakeSettings(), { roleStorage: "global" }));
		const models = resolvingModels(spec => providerModel(spec));
		const recorded = session();
		const outcome = await applyProfile(
			profile({ default: "anthropic/claude:high" }),
			settings,
			models,
			recorded.api,
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.switchedDefault).toBe(true);
		expect(outcome.defaultModel).toBe("anthropic/claude");
		expect(recorded.thinkingLevel()).toBe("high");
	});
	test("preserves max thinking suffix when switching the live session model", async () => {
		const settings = asSettings(Object.assign(new FakeSettings(), { roleStorage: "global" }));
		const models = resolvingModels(spec => providerModel(spec));
		const recorded = session();
		const outcome = await applyProfile(
			profile({ default: "openai-codex/gpt-5.6-luna:max" }),
			settings,
			models,
			recorded.api,
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.switchedDefault).toBe(true);
		expect(outcome.defaultModel).toBe("openai-codex/gpt-5.6-luna");
		expect(recorded.thinkingLevel()).toBe("max");
	});
});
