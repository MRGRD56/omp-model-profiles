import { describe, expect, test } from "bun:test";
import { asSettings, FakeSettings } from "./fake-settings";
import { orderedRoleIds, roleDisplayName, roleTag, snapshotModelRoles } from "../src/roles";

function makeSettings(): FakeSettings {
	const fake = new FakeSettings();
	fake.cycleOrder = ["default", "slow", "team-reviewer"];
	fake.modelTags = { "team-reviewer": { name: "Team Reviewer", color: "accent" } };
	fake.global = {
		default: "anthropic/claude:high",
		"team-reviewer": "openai/gpt:low",
	};
	return fake;
}

describe("roles", () => {
	test("order contains runtime-known roles and profile-only roles without duplicates", () => {
		const settings = asSettings(makeSettings());
		const ids = orderedRoleIds(settings, { "future-role": "provider/model" });

		expect(ids).toContain("default");
		expect(ids).toContain("slow");
		expect(ids).toContain("team-reviewer");
		expect(ids).toContain("future-role");
		expect(new Set(ids).size).toBe(ids.length);

		// Profile-only role is appended after every runtime-known role.
		expect(ids[ids.length - 1]).toBe("future-role");
	});

	test("snapshot preserves custom roles and thinking suffixes verbatim", () => {
		const settings = asSettings(makeSettings());
		const snapshot = snapshotModelRoles(settings);

		expect(snapshot.default).toBe("anthropic/claude:high");
		expect(snapshot["team-reviewer"]).toBe("openai/gpt:low");
	});

	test("display name resolves built-in, custom and unknown roles", () => {
		const settings = asSettings(makeSettings());
		expect(roleDisplayName("default", settings)).toBe("Default");
		expect(roleDisplayName("team-reviewer", settings)).toBe("Team Reviewer");
		expect(roleDisplayName("future-role", settings)).toBe("future-role");
		expect(roleTag("default", settings)).toBe("DEFAULT");
	});
});
