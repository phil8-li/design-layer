# Fixture hosts

Three synthetic Next.js hosts, each with a design system that is genuinely NOT
this repository's. They exist so `host-agnostic-cases.mjs` can prove the editor
reads a host's tokens rather than a memory of the app it was written in.

| Fixture | Tailwind | Tokens arrive as | What it proves |
| --- | --- | --- | --- |
| `aurora-v4/` | v4 | Figma-style manifest + `@theme` | Renamed/extended `@theme` namespaces, `px` tracking, absent Spacing/icons/motion |
| `relay-v3/` | v3 | Figma-style manifest + `tailwind.config.js` | No `@theme` at all, five omitted token groups, literal-valued theme entries |
| `lattice-adapter/` | v4 | A JavaScript module, via `designSystem.adapter` | A host whose tokens were never a manifest |

None of them is a real product. Keep them small: a fixture that grows into a
second design system stops being readable as a counter-example.

## `libraries/` and `variants/`

`variants/` holds source files the variant catalog parses. `libraries/` holds one
file per format the Libraries tab can install — `manifest.json`, `tokens.json`
(Style Dictionary / DTCG), `icons.json`, `theme.css` — and they are documentation
as much as fixtures: they are the answer to "what shape does a design system have
to be in for this editor to read it?".

They are synthetic for a reason that is not the one above. This is a public MIT
repository, and the systems that shaped these rules are not ours to publish. So
these files reproduce the SHAPES those systems
turned out to have — a type word in the middle of a token name rather than at the
front, an alias chain, a `var(--x, 12px)` fallback, a colour whose value is an
unpaintable channel triple, a multi-value radius — with invented names and values.
A fixture here that starts to look like somebody's real product is a mistake in
both directions.
