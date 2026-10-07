/** The right panel's Code tab: header, the code view itself, and its footer. */

import { tokens as t } from "../tokens"

export const codeCss = `/* ---------- code tab ---------- */
.de-code {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
}
.de-code-header {
  flex: none;
  display: flex; align-items: center; gap: ${t.space.sm}px;
  padding: ${t.space.sm}px;
  border-bottom: 1px solid ${t.color.border};
}
/* The picker takes the row; the file reference keeps whatever is left. */
.de-code-header .de-select { flex: 1; min-width: 0; }
.de-code-source {
  flex: none; max-width: 50%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ${t.font.mono};
  font-size: ${t.type.body};
  color: ${t.color.textDim};
}
/* Stands in for the code view, so it has to fill the same slot. */
.de-code .de-empty { flex: 1; min-height: 0; }
.de-code-view {
  flex: 1; min-height: 0;
  /* The slab's inset is the header's and the footer's, so the first character
     of code sits on the same column as the file picker above it; at 10 it was
     two pixels inboard of both and the panel had three left edges. */
  margin: 0; padding: ${t.space.sm}px;
  overflow: auto;
  background: ${t.color.bgSunken};
  color: ${t.color.text};
  font-family: ${t.font.mono};
  font-size: ${t.type.body};
  line-height: ${t.type.leadingCode};
  tab-size: 2;
  white-space: pre;
}
/*
 * One row per logical line, numbered in a gutter, wrapping in place.
 *
 * A 260px panel cannot show a JSX line: at 1440x900 a data-URI src and a
 * sentence of body copy both ran off the right edge with nothing to say they
 * had. Wrapping is the only way the content is all readable, and once a line
 * can occupy several rows it needs a number to still read as one line — which
 * is what open-pencil's view does too.
 *
 * The number is ::before content, so selecting the view and copying it takes
 * the code and leaves the gutter behind. It counts lines in THIS view, not in
 * the file; the file's own line is in the header beside the name.
 */
/* \`minmax(2ch, auto)\` and not \`2ch\`: the gutter reserves two digits, and a
   fixed track made line 100 of a long file spill left out of its own column
   and under the code. Files this view opens routinely run past 99 lines. */
.de-code-line {
  /* The tight step, not the group one: this gutter is 260px of panel away from
     the code it numbers, and every pixel spent parting the two columns is a
     character the wrapped line loses. 8 still reads as a gutter. */
  display: grid; grid-template-columns: minmax(2ch, auto) 1fr; gap: ${t.space.sm}px;
}
.de-code-line::before {
  content: attr(data-line);
  text-align: right;
  color: ${t.color.textDim};
  user-select: none; -webkit-user-select: none;
}
/*
 * The tints are the kit's decorative hues, tuned per theme against \`bgSunken\`
 * in \`tokens.ts\` (the code well is the kit's \`--doc-code-bg\` decision). The
 * next person to move that ground should re-measure rather than re-derive, and
 * the value that goes first is the punctuation.
 */
.de-code-text { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.de-code-tag { color: ${t.code.tag}; }
.de-code-attribute { color: ${t.code.attribute}; }
.de-code-string { color: ${t.code.string}; }
.de-code-number { color: ${t.code.number}; }
.de-code-punctuation { color: ${t.code.punctuation}; }
.de-code-footer {
  flex: none;
  display: flex; align-items: center; justify-content: space-between; gap: ${t.space.sm}px;
  padding: ${t.space.sm}px;
  border-top: 1px solid ${t.color.border};
}
.de-code-status { font-size: ${t.type.body}; color: ${t.color.textDim}; }
.de-code-actions { display: inline-flex; align-items: center; gap: ${t.space["2xs"]}px; }
`
