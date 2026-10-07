/**
 * Deleting a JSX element from a React source file, and putting one in.
 *
 * Every other React edit this package makes goes through the vendored engine,
 * whose jscodeshift transformer knows three verbs: change a className, change
 * some text, reorder two siblings. Removing an element is not among them and
 * cannot be expressed as any of them, so this is the one React write the
 * package performs itself — and inserting one, which arrived with the assets
 * panel, is the second. The two share everything but their splice: the same
 * path resolution, the same per-file batching, the same partial-failure report.
 *
 * It is a byte-range splice, not a codemod, and that is the point. jscodeshift
 * REPRINTS the file it edits; on a file whose formatting nobody asked to change,
 * a one-element deletion can come back as a diff touching two hundred lines.
 * Taking exactly the element's own bytes out leaves everything else — the
 * author's line breaks, their quote style, their trailing commas — untouched.
 *
 * What it refuses is as important as what it does. An element is removable only
 * when it sits in another element's CHILDREN, because that is the only position
 * whose syntax survives the bytes going away:
 *
 *   <div><Card /></div>              removable — the div keeps standing
 *   return <Card />                  refused — `return ;` is not valid
 *   {open && <Card />}               refused — `{open && }` is not valid
 *   items.map(() => <Card />)        refused — the arrow would return nothing
 *
 * The refusals are reported by reason. A user who tries to delete a component's
 * root element is told that is what it is, and the change stays on screen as a
 * preview with a line in the Prompts tab — the same ending every other change
 * this editor cannot write has.
 *
 * Insertion has one refusal of its own, and it is about the import rather than
 * the markup. A `<Button/>` spliced into a file that does not import `Button`
 * compiles to nothing and shows nothing, so the import is not a follow-up step
 * — it is part of the same splice, and an operation that cannot write it does
 * not write the markup either.
 */

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

import { resolveEditableSource } from "../config.mjs"
import { applyEdits, lineExtendedRange, matchNode } from "./element-match.mjs"
import {
  formatImport,
  importDecision,
  importSpecifier,
  insertionEdit,
  isSameModule,
} from "./source-insert.mjs"

/**
 * Babel from the host project when it has one, ours otherwise.
 *
 * The same two-step `server/variants.mjs` makes, for the same reason: a project
 * pinned to a newer parser can have syntax ours cannot read, and the host's own
 * copy is by definition able to parse the host's own files.
 */
let cachedParse = null
function parser(projectRoot) {
  if (cachedParse) return cachedParse
  try {
    const hostRequire = createRequire(path.join(projectRoot, "package.json"))
    ;({ parse: cachedParse } = hostRequire("@babel/parser"))
  } catch {
    ;({ parse: cachedParse } = createRequire(import.meta.url)("@babel/parser"))
  }
  return cachedParse
}

/** Every plugin a modern React file might need, since we never run the output. */
const PLUGINS = ["jsx", "typescript", "decorators-legacy", "classProperties", "explicitResourceManagement"]

function parseFile(projectRoot, source) {
  return parser(projectRoot)(source, {
    sourceType: "module",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: PLUGINS,
  })
}

/** `div`, `Foo.Bar`, `svg:rect` — whatever the JSX actually says. */
function jsxName(name) {
  if (!name) return ""
  if (name.type === "JSXIdentifier") return name.name
  if (name.type === "JSXMemberExpression") return `${jsxName(name.object)}.${jsxName(name.property)}`
  if (name.type === "JSXNamespacedName") return `${jsxName(name.namespace)}:${jsxName(name.name)}`
  return ""
}

/**
 * The static attributes a JSX element declares.
 *
 * Only string literals. `className={cn("card", active && "on")}` is a value
 * this module cannot evaluate, and pretending it has no classes is the honest
 * reading — the descriptor match treats what is written as a SUBSET of what
 * the browser shows, and an empty subset is true of every element. It scores
 * low, which is exactly right: such an element is matched on its tag, its
 * parent and its sibling index, or not at all.
 */
function staticAttributes(element) {
  const attributes = new Map()
  for (const attribute of element.openingElement.attributes ?? []) {
    if (attribute.type !== "JSXAttribute") continue
    const name = jsxName(attribute.name)
    if (!name) continue
    const value = attribute.value
    if (value === null) {
      attributes.set(name, { value: "" })
    } else if (value.type === "StringLiteral") {
      attributes.set(name, { value: value.value })
    }
  }
  return attributes
}

function classesOf(attributes) {
  const written = attributes.get("className") ?? attributes.get("class")
  if (!written) return []
  return written.value.split(/\s+/).filter(Boolean)
}

/**
 * Every JSX element in the file, in the shape `element-match` scores.
 *
 * A hand-rolled walk rather than `@babel/traverse`, which this package does not
 * depend on and would have to. The walk is generic — it recurses into any node
 * or array it finds — so it reaches JSX wherever it is written: inside a
 * ternary, a callback, a default parameter, a decorator.
 *
 * `removable` is decided here because it is a fact about POSITION, and position
 * is only visible while the walk holds the parent. A node collected without it
 * would have to be re-found later to answer the one question that decides
 * whether the splice produces valid code.
 */
export function scanJsx(ast) {
  const nodes = []

  const visit = (node, parentElement, parentIsJsxChild) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parentElement, parentIsJsxChild)
      return
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") return

    if (node.type === "JSXElement") {
      const attributes = staticAttributes(node)
      const record = {
        tagName: jsxName(node.openingElement.name),
        attributes,
        classes: classesOf(attributes),
        nthOfType: 0,
        parentTagName: parentElement ? parentElement.tagName : null,
        parentClasses: parentElement ? parentElement.classes : [],
        start: node.start,
        end: node.end,
        line: node.loc?.start?.line ?? 0,
        selfClosing: Boolean(node.openingElement.selfClosing),
        // Where a child of this element goes. `end` above is the end of the
        // WHOLE element here — unlike a template node, whose `end` is the end
        // of its start tag — so an insertion needs the inner bounds stated
        // separately rather than derived from it.
        contentStart: node.openingElement.end,
        contentEnd: node.closingElement ? node.closingElement.start : -1,
        removable: parentIsJsxChild,
      }
      nodes.push(record)

      // Same-tag index among JSX siblings, so `nthOfType` means here what
      // `previousElementSibling` counting means in the browser.
      const counts = new Map()
      for (const child of node.children ?? []) {
        if (child.type === "JSXElement") {
          const name = jsxName(child.openingElement.name)
          const seen = counts.get(name) ?? 0
          counts.set(name, seen + 1)
          const before = nodes.length
          visit(child, record, true)
          if (nodes[before]) nodes[before].nthOfType = seen
        } else {
          visit(child, record, false)
        }
      }
      // Attributes can hold whole trees — `icon={<Star />}` — and those are NOT
      // children of this element in the DOM sense, so they are walked with no
      // parent element and no removable position.
      visit(node.openingElement.attributes, null, false)
      return
    }

    if (node.type === "JSXFragment") {
      const counts = new Map()
      for (const child of node.children ?? []) {
        if (child.type === "JSXElement") {
          const name = jsxName(child.openingElement.name)
          const seen = counts.get(name) ?? 0
          counts.set(name, seen + 1)
          const before = nodes.length
          visit(child, parentElement, true)
          if (nodes[before]) nodes[before].nthOfType = seen
        } else {
          visit(child, parentElement, false)
        }
      }
      return
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue
      visit(node[key], null, false)
    }
  }

  visit(ast.program ?? ast, null, false)
  return nodes
}

/**
 * The element an operation names, or a reason it cannot be named.
 *
 * A line number, when the resolver produced one, is trusted over the descriptor
 * — it is the browser's own answer for this exact node, while the descriptor is
 * a reconstruction. It is only trusted when it identifies ONE element of the
 * right tag, so a line holding `<span>a</span><span>b</span>` falls through to
 * scoring rather than picking the first.
 */
function findNode(nodes, operation, verb) {
  const descriptor = operation.target ?? {}
  const line = Number(operation.lineNumber) || 0
  if (line > 0) {
    const onLine = nodes.filter((node) => node.line === line && node.tagName === descriptor.tagName)
    if (onLine.length === 1) return { node: onLine[0] }
  }
  const node = matchNode(nodes, descriptor)
  if (!node) return { reason: `no unique <${descriptor.tagName ?? "?"}> to ${verb}` }
  return { node }
}

/** A reference node's bounds, in the shape `source-insert.mjs` splices against. */
function insertAnchor(node) {
  return {
    tagName: node.tagName,
    elementStart: node.start,
    elementEnd: node.end,
    contentStart: node.selfClosing ? -1 : node.contentStart,
    contentEnd: node.selfClosing ? -1 : node.contentEnd,
    selfClosing: node.selfClosing,
  }
}

/**
 * Whether the file declares `name` itself, imports aside.
 *
 * Asked because a declaration collides with an import exactly the way two
 * imports do: `const Card` and `import { Card }` in one file is a duplicate
 * binding, not a shadow. `boundImport` cannot see it — the name is bound by a
 * statement, not by an import — so a file that declares what it is being given
 * looks empty to the import bookkeeping and gets handed the line that breaks
 * it.
 *
 * Only identifier declarations, which is every component anyone inserts. A
 * destructured `const { Card } = kit` is not seen, and is left to the compiler
 * to complain about rather than guessed at here.
 */
function declaresLocally(ast, name) {
  for (const statement of ast.program?.body ?? []) {
    const node =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement
    if (!node) continue
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      if (node.id?.name === name) return true
      continue
    }
    if (node.type !== "VariableDeclaration") continue
    for (const declarator of node.declarations ?? []) {
      if (declarator.id?.type === "Identifier" && declarator.id.name === name) return true
    }
  }
  return false
}

/** The module each of a file's import statements binds `name` to, or null. */
function boundImport(ast, name) {
  for (const node of ast.program?.body ?? []) {
    if (node.type !== "ImportDeclaration") continue
    for (const specifier of node.specifiers ?? []) {
      if (specifier.local?.name === name) return node.source?.value ?? null
    }
  }
  return null
}

/**
 * Where a new import statement goes.
 *
 * Under the last one the file already has, which is where the author would
 * have put it and where every formatter expects to find it. A file with no
 * imports at all gets it above its first statement rather than at byte zero:
 * `node.start` excludes leading comments, so this lands under a file header
 * comment instead of shouldering it out of the way — and above the first
 * statement is also below any `"use client"` directive, which Babel keeps out
 * of `body` entirely.
 */
function importEdit(ast, statement) {
  const body = ast.program?.body ?? []
  let lastImport = null
  for (const node of body) {
    if (node.type === "ImportDeclaration") lastImport = node
  }
  if (lastImport) return { start: lastImport.end, end: lastImport.end, text: `\n${statement}` }
  if (body[0]) return { start: body[0].start, end: body[0].start, text: `${statement}\n\n` }
  return { start: 0, end: 0, text: `${statement}\n` }
}

export function createReactSource(config) {
  const root = config.projectRoot

  /**
   * A client-supplied path, made absolute and proven to be inside the project.
   * Vite hands the browser `/src/App.tsx`; `resolveEditableSource` owns the
   * narrow rule that retries such a path against the root, and the gate.
   */
  const resolveFile = (filePath) => resolveEditableSource(config, filePath)

  /**
   * The batch an operation's file is edited through, opened on first use.
   *
   * Grouping by file is what makes four operations on one page read it, parse
   * it, splice it and write it once instead of four times — and it is also the
   * only way two splices into the same file can be checked against each other
   * for overlap before either is written.
   *
   * Returns null having recorded the reason, which is the partial-failure
   * contract both writers keep: an element that cannot be placed must not stop
   * the four that can.
   */
  const openBatch = (batches, operation, failed) => {
    const file = resolveFile(operation.filePath)
    if (!file) {
      failed.push({
        operation,
        reason: operation.filePath
          ? `${operation.filePath} is outside the editable roots`
          : "no source file was resolved for this element",
      })
      return null
    }

    const existing = batches.get(file)
    if (existing) return { file, batch: existing }

    let source
    try {
      source = fs.readFileSync(file, "utf8")
    } catch (error) {
      failed.push({ operation, reason: `${path.relative(root, file)} is unreadable (${error.message})` })
      return null
    }
    let ast
    let nodes
    try {
      ast = parseFile(root, source)
      nodes = scanJsx(ast)
    } catch (error) {
      failed.push({ operation, reason: `${path.relative(root, file)} does not parse (${error.message})` })
      return null
    }
    // `planned` is the imports this batch has already decided to write, so a
    // second insert of the same component into the same file does not import
    // it twice — and so two inserts wanting the same local name from different
    // modules collide here rather than in the user's build.
    const batch = { source, ast, nodes, edits: [], reports: [], planned: new Map() }
    batches.set(file, batch)
    return { file, batch }
  }

  /** Every batch written back, and every operation in it reported either way. */
  const flushBatches = (batches, applied, failed) => {
    for (const [file, batch] of batches) {
      if (!batch.edits.length) continue
      try {
        fs.writeFileSync(file, applyEdits(batch.source, batch.edits), "utf8")
        for (const report of batch.reports) {
          applied.push({
            op: report.op,
            componentName: report.operation.componentName,
            filePath: path.relative(root, file),
            lineNumber: report.lineNumber,
          })
        }
      } catch (error) {
        for (const report of batch.reports) {
          failed.push({ operation: report.operation, reason: error.message })
        }
      }
    }
  }

  /**
   * The import an insertion needs, as an edit to the receiving file, or null
   * when the file already has it.
   *
   * Throws when the name is spoken for by another module: see `importDecision`
   * for why that has to fail the whole operation rather than splice the markup
   * in and hope.
   */
  const importEditFor = (batch, operation, file) => {
    const request = operation.import
    if (!request) return null
    const receiving = path.relative(root, file)
    // A component dropped into its own file is already in scope, and importing
    // it from itself is what breaks the file rather than what makes it work —
    // see `isSameModule`.
    if (isSameModule(request.from, receiving)) return null
    const specifier = importSpecifier(request.from, receiving)
    const bound = boundImport(batch.ast, request.name) ?? batch.planned.get(request.name) ?? null
    if (!bound && declaresLocally(batch.ast, request.name)) {
      throw new Error(
        `${request.name} is already declared in ${path.basename(file)}, so importing another one would not compile`
      )
    }
    const decision = importDecision(request.name, specifier, bound)
    if (decision.reason) throw new Error(`${decision.reason} in ${path.basename(file)}`)
    if (!decision.add) return null
    batch.planned.set(request.name, specifier)
    return importEdit(batch.ast, formatImport(request.name, request.defaultImport, specifier))
  }

  return {
    /**
     * Deletes elements, grouped by file so each one is read once, spliced once
     * and written once.
     *
     * Partial success is a real outcome and is reported as one: an element that
     * cannot be placed must not stop the four that can.
     */
    remove(operations) {
      const applied = []
      const failed = []
      /** file -> batch, see `openBatch` */
      const batches = new Map()

      for (const operation of operations) {
        const opened = openBatch(batches, operation, failed)
        if (!opened) continue
        const { file, batch } = opened

        const found = findNode(batch.nodes, operation, "delete")
        if (!found.node) {
          failed.push({ operation, reason: `${found.reason} in ${path.basename(file)}` })
          continue
        }
        if (!found.node.removable) {
          // Named precisely, because the two cases have different answers: a
          // root element means "delete the component instead", a conditional
          // one means "delete the branch".
          failed.push({
            operation,
            reason: `<${found.node.tagName}> is not inside another element, so deleting it would leave invalid code`,
          })
          continue
        }
        const { start, end } = lineExtendedRange(found.node.start, found.node.end, batch.source)
        batch.edits.push({ start, end, text: "" })
        batch.reports.push({ op: "removeElement", operation, lineNumber: found.node.line })
      }

      flushBatches(batches, applied, failed)
      return { applied, failed }
    },

    /**
     * Inserts elements, through the same batching, resolution and reporting the
     * deletion above uses.
     *
     * The markup splice and the import statement are pushed as edits to the
     * SAME file in the SAME batch, which is what makes them one write: there is
     * no ordering in which the file can be left holding an element it cannot
     * resolve, because either both splices land or neither does.
     *
     * A null target means the file's root element, which is the outermost JSX
     * in it. That is the first element the walk reaches with no JSX parent, so
     * in a file declaring several components it is the first one's root — a
     * caller that means a specific component's root sends its element as the
     * target, which every caller in this package does.
     */
    insert(operations) {
      const applied = []
      const failed = []
      /** file -> batch, see `openBatch` */
      const batches = new Map()

      for (const operation of operations) {
        const opened = openBatch(batches, operation, failed)
        if (!opened) continue
        const { file, batch } = opened

        const found = operation.target
          ? findNode(batch.nodes, operation, "insert beside")
          : {
              node: batch.nodes.find((node) => !node.removable) ?? null,
              reason: "there is no root element to insert into",
            }
        if (!found.node) {
          failed.push({ operation, reason: `${found.reason} in ${path.basename(file)}` })
          continue
        }
        // `removable` is "this element sits in another element's children", and
        // that is the same fact insertion needs, for the mirror-image reason.
        // A JSX expression holds ONE element, so an element with no JSX parent
        // has no room beside it:
        //
        //   return <h2 />            a sibling makes two adjacent roots
        //   {open && <Card />}       a sibling is a syntax error in the operand
        //   icon={<Star />}          same, in an attribute
        //
        // Every one of those parses as "Adjacent JSX elements must be wrapped
        // in an enclosing tag" and takes the whole module down — the file stops
        // serving, so the page the designer was editing goes blank. Refused by
        // name instead, because the user can act on it: the component goes
        // INSIDE the root, or beside one of its children.
        if (
          !found.node.removable &&
          (operation.position === "before" || operation.position === "after")
        ) {
          failed.push({
            operation,
            reason: `<${found.node.tagName}> is not inside another element, so nothing can sit beside it. Place it inside instead`,
          })
          continue
        }

        try {
          const splice = insertionEdit(
            insertAnchor(found.node),
            operation.position,
            operation.markup,
            batch.source
          )
          const statement = importEditFor(batch, operation, file)
          batch.edits.push(splice)
          if (statement) batch.edits.push(statement)
        } catch (error) {
          failed.push({ operation, reason: error.message })
          continue
        }
        batch.reports.push({ op: "insertElement", operation, lineNumber: found.node.line })
      }

      flushBatches(batches, applied, failed)
      return { applied, failed }
    },

    /** Test seam: the parser is resolved once and cached across calls. */
    reset() {
      cachedParse = null
    },
  }
}
