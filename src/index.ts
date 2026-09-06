import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { KeyId } from "@oh-my-pi/pi-tui";

// OMP 18.1.11 does not use Ctrl+Alt+P for a built-in action.
const DEFAULT_PROFILE_SHORTCUT: KeyId = "ctrl+alt+p";

function profileShortcut(pi: ExtensionAPI): KeyId {
	const extensionConfig = pi.pi.settings.getGlobalSettings().modelProfilesExtension;
	if (typeof extensionConfig !== "object" || extensionConfig === null || Array.isArray(extensionConfig)) {
		return DEFAULT_PROFILE_SHORTCUT;
	}

	const keybindings = (extensionConfig as Record<string, unknown>).keybindings;
	if (typeof keybindings !== "object" || keybindings === null || Array.isArray(keybindings)) {
		return DEFAULT_PROFILE_SHORTCUT;
	}

	const shortcut = (keybindings as Record<string, unknown>).openProfiles;
	return typeof shortcut === "string" && shortcut.trim().length > 0
		? (shortcut.trim().toLowerCase() as KeyId)
		: DEFAULT_PROFILE_SHORTCUT;
}

async function openProfiles(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/profiles is available in TUI mode", "warning");
		return;
	}
	const [{ ProfileStore }, { ProfilesDialog }] = await Promise.all([
		import("./profile-store"),
		import("./profiles-dialog"),
	]);

	const store = new ProfileStore();
	try {
		await store.load();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Cannot open model profiles: ${message}`, "error");
		return;
	}

	// `pi.pi.settings` is the HOST's live Settings singleton. The plugin's
	// module graph is separate, so ProfilesDialog also installs the host
	// Theme into that graph before constructing OMP's native ModelBrowser.
	await ctx.ui.custom(
		(tui, theme, _keybindings, done) =>
			new ProfilesDialog(tui, theme, {
				store,
				settings: pi.pi.settings,
				models: ctx.models,
				pi,
				done: () => done(undefined),
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			},
		},
	);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("profiles", {
		description: "Manage model role profiles",
		async handler(_args, ctx) {
			await openProfiles(pi, ctx);
		},
	});

	pi.registerShortcut(profileShortcut(pi), {
		description: "Open model profiles",
		handler: ctx => openProfiles(pi, ctx),
	});
}
