/**
 * A length on one axis that the layout actually honors.
 *
 * `width: 300px` sizes a block box, but a flex item's main axis answers to
 * more than its width: `flex-grow` stretches it past the length, a
 * `flex-basis` replaces the length outright, and `flex-shrink` squeezes it
 * back whenever the line runs out of room. An inline box ignores width and
 * height altogether, and `min-*` and `max-*` clamp both. A resize handle that
 * wrote the bare length moved nothing on a `flex-1` column, and the width it
 * wrote reached source as a number nobody would ever see.
 *
 * So every fixed length goes through here, from the canvas handles and from
 * the Design tab's W and H alike. What a length needs beside it is Figma's
 * answer for a Fixed child in auto layout: it neither grows nor shrinks.
 */

import { holdTransitions, saveInline } from "./dom"
import type { StyleWrite } from "./writer"

export type Axis = "width" | "height"

const pixels = (value: string): number | null => {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim())
  return match ? Number(match[1]) : null
}

/** Boxes that honor width and height even when they sit inline. */
const REPLACED = /^(img|svg|video|canvas|iframe|object|embed|input|textarea|select|button|audio|picture)$/i

/** Whether `axis` is the main axis of the flex line `element` is an item of. */
export function onFlexMainAxis(element: Element, axis: Axis): boolean {
  const parent = element.parentElement
  if (!parent) return false
  const outer = getComputedStyle(parent)
  if (outer.display !== "flex" && outer.display !== "inline-flex") return false
  // An absolutely positioned child is not a flex item, so none of this applies.
  const position = getComputedStyle(element).position
  if (position === "absolute" || position === "fixed") return false
  return (axis === "height") === (outer.flexDirection ?? "").startsWith("column")
}

/**
 * The element's `min-*` and `max-*` on one axis, in its own box-sizing. Read
 * once by a gesture rather than once per frame. A percentage or `auto` limits
 * nothing this can measure, so it reads as no limit.
 */
export function lengthLimits(element: Element, axis: Axis): { min: number; max: number } {
  const own = getComputedStyle(element)
  return {
    min: pixels(own.getPropertyValue(`min-${axis}`)) ?? 0,
    max: pixels(own.getPropertyValue(`max-${axis}`)) ?? Number.POSITIVE_INFINITY,
  }
}

/** A length clamped into `limits`; CSS lets the minimum win when the two cross, and so does this. */
export function clampInto(limits: { min: number; max: number }, length: number): number {
  return Math.max(limits.min, Math.min(limits.max, length))
}

/** A length in the element's own box-sizing, clamped to its `min-*` and `max-*`. */
export function clampLength(element: Element, axis: Axis, length: number): number {
  return clampInto(lengthLimits(element, axis), length)
}

/** Whether the item's own flex decides its length on `axis`: it grows, or carries a basis. */
export function flexOwnsLength(element: Element, axis: Axis): boolean {
  if (!onFlexMainAxis(element, axis)) return false
  const own = getComputedStyle(element)
  const basis = (own.flexBasis ?? "").trim()
  return Number.parseFloat(own.flexGrow) > 0 || (basis !== "" && basis !== "auto" && basis !== "content")
}

/**
 * What any length on this axis needs beside it, decided by the element's
 * layout alone: `flex: none` for an item whose flex decides its length, and
 * `display: inline-block` for an inline box.
 */
export function lengthCompanions(element: Element, axis: Axis): StyleWrite[] {
  const writes: StyleWrite[] = []
  if (getComputedStyle(element).display === "inline" && !REPLACED.test(element.tagName)) {
    writes.push({ property: "display", value: "inline-block" })
  }
  if (flexOwnsLength(element, axis)) writes.push({ property: "flex", value: "none" })
  return writes
}

/** Whether the line can squeeze this item below a length on `axis`. */
export function shrinkable(element: Element, axis: Axis, companions: readonly StyleWrite[]): boolean {
  if (companions.some((write) => write.property === "flex")) return false
  return onFlexMainAxis(element, axis) && Number.parseFloat(getComputedStyle(element).flexShrink) > 0
}

/** What a length in the element's box-sizing leaves out of its border box on `axis`. */
function boxExtra(element: Element, axis: Axis): number {
  const own = getComputedStyle(element)
  if (own.boxSizing === "border-box") return 0
  const sides = axis === "width" ? ["left", "right"] : ["top", "bottom"]
  let extra = 0
  for (const side of sides) {
    extra += pixels(own.getPropertyValue(`padding-${side}`)) ?? 0
    extra += pixels(own.getPropertyValue(`border-${side}-width`)) ?? 0
  }
  return extra
}

/** `length` as the border box, which is what the layout reports back. */
function borderBox(element: Element, axis: Axis, length: number): number {
  return length + boxExtra(element, axis)
}

/**
 * The element's own `width` or `height` as its box-sizing counts it: the
 * computed length when there is one, otherwise the border box less what
 * `content-box` leaves out (an inline box computes `auto`).
 */
export function ownLength(element: Element, axis: Axis, border: number): number {
  const computed = pixels(getComputedStyle(element).getPropertyValue(axis))
  return computed ?? toOwnLength(element, axis, border)
}

/**
 * A border-box length, which is what the Design tab shows and takes, as the
 * `width` or `height` that draws it: typing 200 into a `content-box` card with
 * 8px padding wrote 200 and drew 216.
 */
export function toOwnLength(element: Element, axis: Axis, border: number): number {
  return Math.max(0, border - boxExtra(element, axis))
}

/**
 * The preview of a length while a scrub or a drag is still deciding it: the
 * same companions the release writes, and `flex-shrink: 0` where a full line
 * could squeeze the length, so the preview is never smaller than the number.
 * The release measures whether that last one is really needed.
 */
export function previewLengthWrites(element: Element, axis: Axis, length: number): StyleWrite[] {
  const value = Math.max(0, Math.round(clampLength(element, axis, length)))
  const companions = lengthCompanions(element, axis)
  const writes: StyleWrite[] = [{ property: axis, value: `${value}px` }, ...companions]
  if (shrinkable(element, axis, companions)) writes.push({ property: "flex-shrink", value: "0" })
  return writes
}

/** The layout box on one axis, before any transform scales or turns it. */
function laidOut(element: Element, axis: Axis): number {
  if (element instanceof HTMLElement) return axis === "width" ? element.offsetWidth : element.offsetHeight
  return element.getBoundingClientRect()[axis]
}

/**
 * Whether the element renders smaller than `length` on `axis`: tries the length
 * with its companions inline, measures, and puts every declaration back. The
 * element's transitions sit the trial out, or the trial would animate twice.
 */
function squeezed(
  element: HTMLElement | SVGElement,
  axis: Axis,
  length: number,
  companions: readonly StyleWrite[]
): boolean {
  const release = holdTransitions(element)
  const restore = saveInline(element, [axis, ...companions.map((write) => write.property)])
  for (const write of companions) element.style.setProperty(write.property, write.value)
  element.style.setProperty(axis, `${length}px`)
  const rendered = laidOut(element, axis)
  restore()
  release()
  // A pixel of slack: `offsetWidth` rounds, and a fraction is not a squeeze.
  return rendered + 1 < borderBox(element, axis, length)
}

/** The writes that make `length` the element's size on `axis`, rounded and clamped. */
export function lengthWrites(element: HTMLElement | SVGElement, axis: Axis, length: number): StyleWrite[] {
  const value = Math.max(0, Math.round(clampLength(element, axis, length)))
  const companions = lengthCompanions(element, axis)
  const writes: StyleWrite[] = [{ property: axis, value: `${value}px` }, ...companions]
  if (shrinkable(element, axis, companions) && squeezed(element, axis, value, companions)) {
    writes.push({ property: "flex-shrink", value: "0" })
  }
  return writes
}

/** Several axes' writes as one list, each property once (both axes can ask for `flex: none`). */
export function mergeWrites(...lists: StyleWrite[][]): StyleWrite[] {
  const merged = new Map<string, StyleWrite>()
  for (const list of lists) for (const write of list) merged.set(write.property, write)
  return [...merged.values()]
}
