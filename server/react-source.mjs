/**
 * Every JSX element a React source file writes, by tag name and line.
 *
 * `server/component-usage.mjs` counts where a component is used from this.
 * This module used to be the React source writer too (deleting and inserting
 * JSX elements by byte-range splice); that went when edits became notes for a
 * coding agent, and the walk is what is left.
 */

/** `div`, `Foo.Bar`, `svg:rect` — whatever the JSX actually says. */
function jsxName(name) {
  if (!name) return ""
  if (name.type === "JSXIdentifier") return name.name
  if (name.type === "JSXMemberExpression") return `${jsxName(name.object)}.${jsxName(name.property)}`
  if (name.type === "JSXNamespacedName") return `${jsxName(name.namespace)}:${jsxName(name.name)}`
  return ""
}

/**
 * Every JSX element in the file, in source order, with its tag and line.
 *
 * A hand-rolled walk rather than `@babel/traverse`, which this package does not
 * depend on and would have to. The walk is generic — it recurses into any node
 * or array it finds — so it reaches JSX wherever it is written: inside a
 * ternary, a callback, a default parameter, a decorator.
 */
export function scanJsx(ast) {
  const nodes = []

  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") return

    if (node.type === "JSXElement") {
      nodes.push({ tagName: jsxName(node.openingElement.name), line: node.loc?.start?.line ?? 0 })
      // Attributes can hold whole trees — `icon={<Star />}` — and those count
      // as usages too.
      visit(node.openingElement.attributes)
      visit(node.children)
      return
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue
      visit(node[key])
    }
  }

  visit(ast.program ?? ast)
  return nodes
}
