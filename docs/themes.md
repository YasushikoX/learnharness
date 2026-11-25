# Themes

**Settings → Appearance → Theme** sets the app's UI palette.
LearnHarness ships thirteen presets: Dark (the default) and Light, a neutral pair with grey
surfaces, hairline borders and one blue accent; Warm Brass (the brown and brass palette that was the
default until November 2026); Catppuccin Latte, Frappé, Macchiato and Mocha; Rosé Pine and Rosé Pine
Dawn; Gruvbox Dark; Ivory; Pastel; and NvChad Onedark.

Preset ids never change. Warm Brass still has the id `default`, so a saved selection of the old
default keeps showing it. A record with no saved theme shows Dark (`dark`). Light is `light`.
Each theme declares whether it is dark or light. The native window background
follows the effective background, including your override; native control symbols
choose a contrasting ink. Mermaid diagrams follow the theme's light/dark mode.
Generated figures keep their own colors and existing inversion controls. Plugins
that use the app's CSS tokens inherit them; plugin-specific palettes and artwork
are not rewritten.

## Overriding single colors

The **Colors** block under the theme grid has one field per theme color. A filled
field wins over the active theme; an empty field uses the theme's value, shown in
its hint. Overrides are kept when you switch themes, so a background you like
survives a change of palette. **Reset all** clears every override.

`background`, `bold` and `italic` keep their pre-theme settings keys
(`appearance.background`, `mdRendering.boldColor`, `mdRendering.italicColor`), so
values set in older versions keep working.

## Theme files

**Export JSON** downloads the active theme with your overrides applied. Importing
that file back reproduces what is on screen. **Import JSON** accepts a file in this
shape:

```json
{
	"name": "My Theme",
	"mode": "dark",
	"colors": {
		"background": "#1e1e2e",
		"surface": "#313244",
		"border": "#45475a",
		"text": "#cdd6f4",
		"textMuted": "#a6adc8",
		"accent": "#cba6f7",
		"bold": "#b4befe",
		"italic": "#f5c2e7",
		"code": "#fab387",
		"error": "#f38ba8",
		"success": "#a6e3a1",
		"warning": "#f9e2af"
	}
}
```

All twelve colors are required, as `#rgb` or `#rrggbb` hex. `mode` is `"dark"` or
`"light"`. A file with a missing or invalid key is refused, and the error names
the key.

| Key | Where it shows |
|---|---|
| `background` | Page background |
| `surface` | Cards, popovers, inputs; hover fills and secondary buttons derive from it |
| `border` | Hairline borders; input borders derive from it |
| `text` | Body text |
| `textMuted` | Secondary text and hints |
| `accent` | Focus rings, toggles, selection, the selected theme card |
| `bold` | **Bold** text in lessons |
| `italic` | *Italic* text in lessons |
| `code` | Inline `code` in lessons |
| `error` | Errors, wrong answers, destructive actions |
| `success` | Correct answers, connected states |
| `warning` | Warnings and partial states |

## Derived colors

Some roles have no key of their own. The app computes them from the twelve colors, so every preset and
every imported file gets them, and your overrides carry through:

| CSS variable | Derived from |
|---|---|
| `--lh-sidebar` | `background`, 2.5% toward `text` |
| `--lh-raised` (also `--accent`, `--secondary`) | `surface`, one step lighter (dark) or darker (light): hover fills, selected rows, secondary buttons |
| `--lh-raised-strong` | `surface`, two steps: pressed fills, a secondary button's hover, an off toggle |
| `--input` | `border`, 7.5% toward `text`: input, select and outline-button borders |
| `--lh-focus-ring` | `accent` at 40% opacity: the keyboard focus ring |

The dialog scrim (`--lh-scrim`) and the shadow of menus, popovers and dialogs (`--lh-shadow-pop`)
depend only on the theme's mode.

Primary buttons use the theme's text color on its background, except in Dark and Light (blue with white
text) and Warm Brass (brass).

## Where custom themes live

Imported themes are saved as `<id>.json` in the `themes/` folder of the app data
directory (`data/themes/` in a development checkout, or under Electron `userData`
in the desktop app). The id is a slug of the name; a name that collides with an
existing theme gets a `-2`, `-3`… suffix. Preset ids are reserved.

Removing the active custom theme switches back to Dark and keeps your overrides.
If the selected file is removed or becomes invalid outside the app, the UI falls
back to Dark; the next appearance save also repairs the saved selection, so
font and other appearance edits remain available.
