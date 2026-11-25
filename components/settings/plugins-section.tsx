"use client";

import { RefreshCw, Settings } from "lucide-react";
import { usePlugins } from "@/components/plugins";
import type { FrontendPlugin } from "@/components/plugin-manager";
import { Button } from "@/components/ui/button";
import { SettingsList, SettingsRow, SettingsSection, Toggle } from "./controls";

export const PLUGIN_TRUST_WARNING = "Only enable plugins you trust. Plugins run trusted local code with broad file and network access; they are not sandboxed. A broken plugin may require restarting LearnHarness.";

export function PluginsSection({ onOpenSettings, origin = "community" }: { onOpenSettings?: (pluginId: string) => void; origin?: "core" | "community" }) {
	const { manager, snapshot } = usePlugins();
	const core = origin === "core";
	const plugins = snapshot.plugins.filter(plugin => plugin.info.origin === origin);
	return <SettingsSection title={core ? "Core plugins" : "Community plugins"} testid={core ? "section-core-plugins" : "section-plugins"}>
		{!core && <>
		<p className="text-sm/5 text-muted-foreground">{PLUGIN_TRUST_WARNING}</p>
		<SettingsList>
			<details data-testid="plugin-install-help" className="text-sm/5 text-muted-foreground">
				<summary className="w-fit cursor-pointer list-none text-muted-foreground underline underline-offset-2 hover:text-foreground [&::-webkit-details-marker]:hidden">How to install a plugin</summary>
				<ol className="mt-2 list-decimal space-y-2 pl-5">
					<li>Clone or copy the plugin into the directory below, using its plugin ID as the folder name.</li>
					<li>For source projects, follow the repository’s dependency setup and run <code>npm run build</code>. Prebuilt packages already contain <code>dist/manifest.json</code> and need no build.</li>
					<li>Refresh the list, then enable the plugin. New plugins are disabled by default.</li>
					<li>Restart LearnHarness after changing loaded code. Preserve <code>data/</code> beside <code>dist/</code> when updating.</li>
				</ol>
			</details>
			<SettingsRow testid="plugin-authoring-help" label="Build a plugin" hint="Download the authoring skill for your coding agent.">
				<Button variant="outline" asChild><a href="/plugin-authoring/learnharness-plugins.zip" download={`learnharness-plugins-${process.env.LH_VERSION ?? "authoring"}.zip`} data-testid="download-plugin-authoring">Download authoring skill</a></Button>
			</SettingsRow>
			<SettingsRow testid="plugin-directory" label="Plugins directory" hint={<code className="wrap-anywhere select-text">{snapshot.directory}</code>}>
					<Button variant="outline" size="icon" aria-label="Refresh plugins" title="Refresh plugins" aria-busy={snapshot.refreshing}
						disabled={!manager || snapshot.refreshing || snapshot.plugins.some(plugin => plugin.busy)} onClick={() => void manager?.refresh()}>
						<RefreshCw aria-hidden="true" className={snapshot.refreshing ? "animate-spin" : undefined} />
					</Button>
			</SettingsRow>
		</SettingsList>
		{snapshot.conflicts.map(conflict => <p role="alert" key={conflict.id} className="break-words text-xs text-destructive">{conflict.error}</p>)}
		</>}
		{snapshot.error && <p role="alert" className="text-xs text-destructive">{snapshot.error}</p>}
		{snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading plugins…</p>
			: plugins.length === 0 ? <p className="text-xs text-muted-foreground">{core ? "No Core plugins available." : "No community plugins installed."}</p>
				: <SettingsList>{plugins.map(plugin => <PluginRow key={plugin.info.id} plugin={plugin}
					onSettings={() => onOpenSettings?.(plugin.info.id)} />)}</SettingsList>}
	</SettingsSection>;
}

function PluginRow({ plugin, onSettings }: { plugin: FrontendPlugin; onSettings: () => void }) {
	const { manager, snapshot } = usePlugins();
	const { info } = plugin;
	const name = info.manifest?.name ?? info.id;
	const status = [info.origin === "community" ? info.manifest?.version : undefined, plugin.busy ? "Saving…" : plugin.error ? "Error" : plugin.phase === "loading" ? "Loading…" : info.enabled ? "Enabled" : "Disabled"].filter(Boolean).join(" · ");
	return <div className="lh-settings-row-group" data-testid={`plugin-${info.id}`}>
		<SettingsRow label={name} hint={<>{info.manifest?.description && <span className="block">{info.manifest.description}</span>}{status}</>}>
			<div className="flex shrink-0 items-center gap-2">
				{info.enabled && <Button type="button" variant="ghost" size="icon" aria-label={`Settings for ${name}`} title={`Settings for ${name}`}
					className="text-muted-foreground hover:text-foreground"
					onClick={onSettings}><Settings aria-hidden strokeWidth={1.75} /></Button>}
				<Toggle label={`Enable ${name}`} checked={info.enabled} disabled={!manager || plugin.busy || snapshot.refreshing || (!info.manifest && !info.enabled)} onChange={enabled => void manager?.setEnabled(info.id, enabled)} />
			</div>
		</SettingsRow>
		{plugin.error && <p role="alert" className="px-4 pb-2 text-sm wrap-anywhere text-destructive">{plugin.error}</p>}
	</div>;
}
