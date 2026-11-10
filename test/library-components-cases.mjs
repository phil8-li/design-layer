/**
 * The component scanner: what a React or Angular directory is read as.
 *
 * `server/library-components.mjs` is fifteen hundred lines of textual scanning
 * that decides which components a library declares, which props each takes,
 * which values each prop offers and which one it defaults to. Until this suite
 * the only case that ran it asserted component NAMES, so every rule about props
 * could change without a test noticing. The rules pinned here are the ones a
 * designer sees: the options a picker offers and the one it preselects.
 *
 * Every fixture is written into a fresh temp directory, so each case reads as
 * the documentation of one source shape.
 *
 * Usage: node test/library-components-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { looksLikeComponentLibrary, scanComponentLibrary } from "../server/library-components.mjs"

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/** A temp library holding `files` (relative path -> source), removed afterwards. */
async function library(files, fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dl-components-")))
  try {
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(root, relative)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, source, "utf8")
    }
    return await fn(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

const byName = (components, name) => components.find((component) => component.name === name)
const names = (components) => components.map((component) => component.name)

console.log("\nWhich files declare components")

/*
 * The folder-per-component layout puts each component in `button/index.tsx`.
 * The scanner skipped every `index.*` as a barrel and read none of them.
 */
await check("a component declared in a folder's index file is read", async () => {
  await library(
    {
      "button/index.tsx":
        "export interface ButtonProps { size?: 'sm' | 'md' }\n" +
        "export function Button({ size = 'md' }: ButtonProps) { return <button /> }\n",
      "card/Card.tsx": "export function Card() { return <div /> }\n",
      "card/index.ts": "export { Card } from './Card'\nexport * from './Card'\n",
    },
    async (root) => {
      const { components, framework } = await scanComponentLibrary(root)
      assert.deepEqual(names(components), ["Button", "Card"], "a barrel listed its component twice, or an index was skipped")
      assert.equal(byName(components, "Button").file, "button/index.tsx")
      assert.equal(byName(components, "Button").props[0].default, "md")
      assert.equal(framework, "react")
      assert.equal(await looksLikeComponentLibrary(root), true)
    }
  )
})

await check("specs, tests, stories and declaration files are not read", async () => {
  await library(
    {
      "Chip.tsx": "export function Chip() { return <span /> }\n",
      "Chip.spec.tsx": "export function ChipSpec() { return <Chip /> }\n",
      "Chip.test.tsx": "export function ChipTest() { return <Chip /> }\n",
      "Chip.stories.tsx": "export function Primary() { return <Chip /> }\n",
      "Chip.d.ts": "export function ChipTypes(): JSX.Element\n",
    },
    async (root) => {
      assert.deepEqual(names((await scanComponentLibrary(root)).components), ["Chip"])
    }
  )
})

console.log("\nWhat a React component offers")

await check("a literal union is a prop's options, and a named one is followed", async () => {
  await library(
    {
      "Button.tsx": [
        "type Size = 'sm' | 'md' | 'lg'",
        "/** The main action. */",
        "export interface ButtonProps {",
        "  variant?: 'primary' | 'ghost'",
        "  size?: Size",
        "  label: string",
        "  wide?: 'yes' | string",
        "  onTone?: (tone: Size) => void",
        "  onClose(): void",
        "  [key: string]: unknown",
        "}",
        "export function Button({ variant = 'ghost', size = 'xl' }: ButtonProps) { return <button /> }",
      ].join("\n"),
    },
    async (root) => {
      const button = byName((await scanComponentLibrary(root)).components, "Button")
      const props = Object.fromEntries(button.props.map((prop) => [prop.name, prop]))
      assert.deepEqual(Object.keys(props), ["variant", "size", "label", "wide", "onTone"])
      assert.deepEqual(props.variant.values, ["primary", "ghost"])
      assert.equal(props.variant.default, "ghost")
      assert.deepEqual(props.size.values, ["sm", "md", "lg"])
      // A default the union does not allow is dropped rather than preselected.
      assert.equal(props.size.default, undefined)
      // Widened by `string`: its real domain is every string.
      assert.equal(props.wide.values, undefined)
      // A callback that mentions the options union is not one.
      assert.equal(props.onTone.values, undefined)
      assert.equal(button.description, "The main action.")
      assert.equal(button.snippet, '<Button variant="primary" />')
    }
  )
})

await check("a union broken across lines and members with no separators are both read", async () => {
  await library(
    {
      "Tag.tsx": [
        "export interface TagProps {",
        "  tone?:",
        "    | 'neutral'",
        "    | 'loud'",
        "  shape?: 'round' | 'square'",
        "}",
        "export const Tag = (props: TagProps) => <span />",
      ].join("\n"),
    },
    async (root) => {
      const tag = byName((await scanComponentLibrary(root)).components, "Tag")
      assert.deepEqual(
        tag.props.map((prop) => [prop.name, prop.values]),
        [["tone", ["neutral", "loud"]], ["shape", ["round", "square"]]]
      )
    }
  )
})

await check("forwardRef, defaultProps and a default export are all understood", async () => {
  await library(
    {
      "Card.tsx": [
        "import React from 'react'",
        "export interface CardProps { tone?: 'loud' | 'quiet'; size?: 's' | 'm' }",
        "export const Card = React.forwardRef<HTMLDivElement, CardProps>(({ tone = 'quiet' }, ref) => <div ref={ref} />)",
        "Card.defaultProps = { size: 'm', tone: 'loud' }",
      ].join("\n"),
      "Panel.tsx": [
        "interface Props { elevation?: 'flat' | 'raised' }",
        "function Panel({ elevation = 'raised' }: Props) { return <section /> }",
        "export function PanelShell() { return null }",
        "export default Panel",
      ].join("\n"),
      "Data.tsx": "export const Palette = { red: '#f00' }\n",
    },
    async (root) => {
      const { components } = await scanComponentLibrary(root)
      assert.deepEqual(names(components), ["Card", "PanelShell"], "data or an unexported function was listed")
      const card = byName(components, "Card")
      // The signature's default wins over `defaultProps` for the same prop.
      assert.deepEqual(
        card.props.map((prop) => [prop.name, prop.default]),
        [["tone", "quiet"], ["size", "m"]]
      )
      assert.equal(card.exportName, "Card")
      assert.equal(card.defaultExport, false)
    }
  )
})

await check("two components of one name in two folders keep two ids", async () => {
  await library(
    {
      "a/Card.tsx": "export function Card() { return <div /> }\n",
      "b/Card.tsx": "export function Card() { return <div /> }\n",
    },
    async (root) => {
      const { components } = await scanComponentLibrary(root)
      assert.deepEqual(components.map((component) => component.id), ["component:card", "component:card-2"])
      assert.deepEqual(components.map((component) => component.group), ["A", "B"])
    }
  )
})

console.log("\nWhat an Angular component offers")

await check("decorator and signal inputs are read, with aliases, defaults and the selector", async () => {
  await library(
    {
      "badge/badge.component.ts": [
        "import { Component, Input, input, model } from '@angular/core'",
        "type Tone = 'info' | 'warn'",
        "/** A status badge. */",
        "@Component({ selector: 'x-badge, [x-badge]', template: `<span class=\"{{ tone }}\">{{ label() }}</span>` })",
        "export class BadgeComponent {",
        "  @Input('kind') tone: Tone = 'info'",
        "  @Input({ alias: 'emphasis' }) strong: 'yes' | 'no' = 'no'",
        "  @Input() set density(next: 'cozy' | 'compact') {}",
        "  size = input<'s' | 'm'>('m')",
        "  open = model<boolean>(false)",
        "  label = input.required<string>({ alias: 'text' })",
        "}",
      ].join("\n"),
    },
    async (root) => {
      const { components, framework } = await scanComponentLibrary(root)
      assert.equal(framework, "angular")
      const badge = byName(components, "BadgeComponent")
      assert.equal(badge.selector, "x-badge")
      assert.equal(badge.description, "A status badge.")
      assert.equal(badge.snippet, '<x-badge kind="info"></x-badge>')
      const props = Object.fromEntries(badge.props.map((prop) => [prop.name, prop]))
      assert.deepEqual(Object.keys(props), ["kind", "emphasis", "density", "size", "open", "label"])
      assert.deepEqual(props.kind.values, ["info", "warn"])
      assert.equal(props.kind.default, "info")
      assert.equal(props.emphasis.default, "no")
      assert.deepEqual(props.density.values, ["cozy", "compact"])
      assert.equal(props.size.default, "m")
      // `input.required()` takes its options object first, never a default.
      assert.equal(props.label.default, undefined)
    }
  )
})

console.log("\nWhat a scan hands out")

await check("a caller that edits a scanned component does not edit the next scan", async () => {
  await library(
    {
      "Button.tsx":
        "export interface ButtonProps { size?: 'sm' | 'md' }\n" +
        "export function Button({ size }: ButtonProps) { return <button /> }\n",
    },
    async (root) => {
      const first = byName((await scanComponentLibrary(root)).components, "Button")
      first.props[0].values.push("xl")
      first.props[0].name = "changed"
      const second = byName((await scanComponentLibrary(root)).components, "Button")
      assert.deepEqual(second.props[0].values, ["sm", "md"])
      assert.equal(second.props[0].name, "size")
    }
  )
})

await check("an edit, an addition and a deletion all show on the next scan", async () => {
  await library({ "One.tsx": "export function One() { return null }\n" }, async (root) => {
    assert.deepEqual(names((await scanComponentLibrary(root)).components), ["One"])
    await fs.writeFile(path.join(root, "One.tsx"), "export function Uno() { return <i /> }\n", "utf8")
    await fs.writeFile(path.join(root, "Two.tsx"), "export function Two() { return null }\n", "utf8")
    assert.deepEqual(names((await scanComponentLibrary(root)).components), ["Two", "Uno"])
    await fs.rm(path.join(root, "Two.tsx"))
    assert.deepEqual(names((await scanComponentLibrary(root)).components), ["Uno"])
  })
})

await check("an unreadable path is an empty library, not an error", async () => {
  const result = await scanComponentLibrary(path.join(os.tmpdir(), "dl-components-does-not-exist"))
  assert.deepEqual(result, { components: [], framework: null })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
