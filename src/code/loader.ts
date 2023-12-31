import { ExpressionStatement, Node, Program } from "acorn";
import fs from "fs";
import path from "path";
import { CodeParser } from "./parser";
import { CodeError, CodeErrorType, CodeSource } from "./types";
import { getJSXAttribute, getJSXAttributeKeys, getJSXAttributeNode, removeJSXAttribute } from "./utils";
import { JSXElement, JSXText, walker } from "./walker";

const MAX_NESTING = 100;
const TAGS_PREFIX = ':';
const INCLUDE_TAG = ':include';
const IMPORT_TAG = ':import';
const INCLUDE_SRC_ATTR = 'src';
const DEFINE_TAG = ':define';
const DEFINE_TAG_ATTR = 'tag';
const SLOT_TAG = ':slot';
const SLOT_NAME_ATTR = 'name';
const SLOT_DEFAULT_NAME = 'default';

type Directive = {
  name: string,
  node: JSXElement,
  parent: JSXElement
};

type MacroDefinition = {
  name: string;
  node: JSXElement;
  base: string;
  from?: MacroDefinition;
}

export interface CodeLoaderSource extends CodeSource {
  macros: { [key: string]: MacroDefinition };
}

/**
 * Loads page source files from a given document root directory,
 * preventing access outside of it.
 * Parses the pages using CodeParser, resolves possible inclusions,
 * and returns combined ASTs.
 */
export class CodeLoader {
  rootPath: string;
  parser: CodeParser;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.parser = new CodeParser();
  }

  async load(fname: string): Promise<CodeSource> {
    const ret: CodeLoaderSource = {
      files: [],
      errors: [],
      macros: {}
    };
    ret.ast = await this.parse(fname, '.', ret, 0);
    this.expandMacros(ret.ast!, ret, 0);
    return ret;
  }

  async parse(
    fname: string, currDir: string, source: CodeLoaderSource,
    nesting: number, once = false, from?: any
  ): Promise<Program | undefined> {
    let program: Program | undefined;
    if (nesting >= MAX_NESTING) {
      this.addError('error', `too many nested inclusions`, source, from);
      return;
    }
    if (fname.startsWith('/')) {
      currDir = '';
    }
    const pname = path.normalize(path.join(this.rootPath, currDir, fname));
    if (!pname.startsWith(this.rootPath)) {
      const s = path.relative(this.rootPath, pname);
      this.addError('error', `forbidden pathname "${s}"`, source, from);
      return;
    }
    const relPath = pname.substring(this.rootPath.length);
    if (source.files.indexOf(relPath) < 0) {
      source.files.push(relPath);
    } else if (once) {
      return;
    }
    let text = '';
    try {
      text = await fs.promises.readFile(pname, { encoding: 'utf8' });
    } catch (error: any) {
      this.addError('error', `failed to read "${relPath}"`, source, from);
      return;
    }
    try {
      program = this.parser.parse(text, relPath);
    } catch (error: any) {
      this.addError('error', `${error} in "${relPath}"`, source, from);
      return;
    }
    const body = program.body;
    //TODO: we should remove possible leading JSXText nodes
    if (
      body.length < 1 ||
      body[0].type !== 'ExpressionStatement' ||
      // @ts-ignore
      body[0].expression.type !== 'JSXElement'
    ) {
      this.addError('error', `HTML tag expected "${relPath}"`, source, source.ast);
      return;
    }
    await this.processDirectives(program, path.dirname(relPath), source, nesting);
    return program;
  }

  async processDirectives(
    program: Program, currDir: string, source: CodeLoaderSource, nesting: number
  ) {
    const directives = new Array<Directive>();
    // https://github.com/acornjs/acorn/blob/master/acorn-walk/README.md
    walker.ancestor(program, {
      // @ts-ignore
      JSXElement(node, _, ancestors) {
        const parent = (ancestors.length > 1 ? ancestors[ancestors.length - 2] : null);
        if (
          node.type === 'JSXElement' &&
          parent?.type === 'JSXElement' &&
          node.openingElement.name.type === 'JSXIdentifier' &&
          node.openingElement.name.name.startsWith(TAGS_PREFIX)
        ) {
          const name = node.openingElement.name.name;
          directives.push({ name, node, parent });
        }
      }
    });
    for (let d of directives) {
      const i = d.parent.children.indexOf(d.node);
      if (d.name === INCLUDE_TAG || d.name === IMPORT_TAG) {
        i >= 0 && d.parent.children.splice(i, 1);
        await this.processInclude(d, i, currDir, source, nesting);
      } else if (d.name === DEFINE_TAG) {
        i >= 0 && d.parent.children.splice(i, 1);
        this.collectMacro(d, source);
      } else if (d.name === SLOT_TAG) {
        // nop
      } else {
        i >= 0 && d.parent.children.splice(i, 1);
        source.errors.push(new CodeError(
          'warning', `unknown directive ${d.name}`, d.node
        ));
      }
    }
  }

  // ===========================================================================
  // inclusions
  // ===========================================================================

  async processInclude(
    d: Directive, i: number, currDir: string, source: CodeLoaderSource, nesting: number,
  ) {
    const src = getJSXAttribute(d.node.openingElement, INCLUDE_SRC_ATTR);
    if (!src?.trim()) {
      source.errors.push(new CodeError(
        'error', `missing ${INCLUDE_SRC_ATTR} attribute`, d.node
      ));
      return;
    }
    const program = await this.parse(
      src, currDir, source, nesting + 1, (d.name === IMPORT_TAG), d.node
    );
    if (!program) {
      return;
    }
    const es = program.body[0] as ExpressionStatement;
    const rootElement = es.expression as unknown as JSXElement;
    // apply root attributes
    this.applyIncludedAttributes(d, rootElement);
    // include contents
    const nn = [...rootElement.children];
    if (nn.length > 0) {
      const n = nn[0] as JSXText;
      if (n.type === 'JSXText' && /^\s*$/.test(n.value)) {
        nn.shift();
      }
    }
    if (nn.length > 0) {
      const n = nn[nn.length - 1] as JSXText;
      if (n.type === 'JSXText' && /^\s*$/.test(n.value)) {
        nn.pop();
      }
    }
    d.parent.children.splice(i, 0, ...nn);
  }

  addError(type: CodeErrorType, msg: string, ret: CodeLoaderSource, from?: Node) {
    ret.errors.push(new CodeError(type, msg, from));
  }

  applyIncludedAttributes(directive: Directive, rootElement: JSXElement) {
    const p = directive.parent.openingElement;
    const r = rootElement.openingElement;
    const existing = getJSXAttributeKeys(p);
    const included = getJSXAttributeKeys(r)
    for (let key of included) {
      if (!existing.includes(key)) {
        const attr = getJSXAttributeNode(r, key);
        p.attributes.push(attr!);
      }
    }
  }

  // ===========================================================================
  // macros
  // ===========================================================================

  collectMacro(d: Directive, source: CodeLoaderSource) {
    const tag = getJSXAttribute(d.node.openingElement, DEFINE_TAG_ATTR);
    if (!tag) {
      source.errors.push(new CodeError(
        'warning', `bad or missing ${DEFINE_TAG_ATTR} attribute`, d.node
      ));
      return;
    }
    const res = /^([\-\w]+)(\:[\-\w]+)?$/.exec(tag);
    if (!res) {
      source.errors.push(new CodeError(
        'warning',
        `invalid tag name "${tag} (does it include a dash?)"`,
        d.node
      ));
      return;
    }
    const name = res[1];
    const base = (res.length > 1 && res[2] ? res[2].substring(1) : 'div');
    const from = base.indexOf('-') > 0 ? source.macros[base] : undefined;
    removeJSXAttribute(d.node.openingElement, DEFINE_TAG_ATTR);
    d.node.openingElement.name.name = base;
    if (d.node.openingElement.selfClosing) {
      d.node.openingElement.selfClosing = false;
      d.node.closingElement = {
        type: "JSXClosingElement",
        name: d.node.openingElement.name,
        start: d.node.start, end: d.node.end, loc: d.node.loc
      }
    } else {
      d.node.closingElement.name.name = base;
    }
    let node = d.node;
    if (from) {
      node = this.expandMacro(d.node, from, source, false, 0);
    }
    source.macros[name] = { name, node, base, from };
  }

  collectSlots(
    node: JSXElement, source: CodeLoaderSource,
    ignore?: { [key: string]: { node: JSXElement, parent: JSXElement } }
  ): { [key: string]: { node: JSXElement, parent: JSXElement } } {
    const ret: { [key: string]: { node: JSXElement, parent: JSXElement } } = {};
    walker.ancestor(node, {
      // @ts-ignore
      JSXElement(node, _, ancestors) {
        const parent = (ancestors.length > 1 ? ancestors[ancestors.length - 2] : null);
        if (
          node.type === 'JSXElement' &&
          parent?.type === 'JSXElement' &&
          node.openingElement.name.type === 'JSXIdentifier' &&
          node.openingElement.name.name === SLOT_TAG
        ) {
          const name = getJSXAttribute(node.openingElement, SLOT_NAME_ATTR);
          if (!name) {
            source.errors.push(new CodeError(
              'error', 'missing slot "name" attribute', node.openingElement
            ));
            return;
          }
          if (ignore) {
            const islot = ignore[name];
            if (node === islot?.node) {
              return;
            }
          }
          ret[name] = { node, parent };
        }
      }
    });
    if (!ret[SLOT_DEFAULT_NAME] && !ignore) {
      const slot = this.addDefaultSlot(node);
      ret[SLOT_DEFAULT_NAME] = slot;
    }
    return ret;
  }

  expandMacros(root: Node, source: CodeLoaderSource, nesting: number) {
    const that = this;
    const ee = new Array<{
      use: JSXElement,
      res: JSXElement,
      parent: JSXElement
    }>();
    // expand macros
    root && walker.ancestor(root, {
      // @ts-ignore
      JSXElement(node, _, ancestors) {
        const parent = (ancestors.length > 1 ? ancestors[ancestors.length - 2] : null);
        if (
          node.type === 'JSXElement' &&
          parent?.type === 'JSXElement' &&
          node.openingElement.name.type === 'JSXIdentifier'
        ) {
          const name = node.openingElement.name.name;
          const macro = source.macros[name];
          if (macro) {
            const res = that.expandMacro(node, macro, source, true, nesting);
            res && ee.push({ use: node, res, parent });
          }
        }
      }
    });
    // replace usages
    for (let e of ee) {
      const i = e.parent.children.indexOf(e.use);
      e.parent.children.splice(i, 1, e.res);
      this.expandMacros(e.res, source, nesting + 1);
    }
  }

  expandMacro(
    use: JSXElement, macro: MacroDefinition, source: CodeLoaderSource,
    removeSlots: boolean, nesting: number
  ): JSXElement {
    if (nesting > MAX_NESTING) {
      source.errors.push(new CodeError(
        'error', `too many nested macros "${macro.name}"`, use
      ));
      return use;
    }
    let ret: JSXElement = JSON.parse(JSON.stringify(macro.node));
    const oldSlots = this.populateMacro(use, ret, source, removeSlots);
    if (!removeSlots) {
      const newSlots = this.collectSlots(ret, source, oldSlots);
      for (let key of Reflect.ownKeys(newSlots) as string[]) {
        const oldSlot = oldSlots[key];
        if (oldSlot) {
          const i = oldSlot.parent.children.indexOf(oldSlot.node);
          oldSlot.parent.children.splice(i, 1);
        }
      }
    }
    return ret;
  }

  populateMacro(
    src: JSXElement, dst: JSXElement, source: CodeLoaderSource,
    removeSlots: boolean
  ): { [key: string]: { node: JSXElement, parent: JSXElement } } {
    for (let key of getJSXAttributeKeys(src.openingElement)) {
      const srcAttr = getJSXAttributeNode(src.openingElement, key)!;
      const dstAttr = getJSXAttributeNode(dst.openingElement, key);
      if (dstAttr) {
        dstAttr.value = srcAttr.value
      } else {
        dst.openingElement.attributes.push(srcAttr);
      }
    }
    const slots = this.collectSlots(dst, source);
    for (let node of src.children) {
      let slotName = SLOT_DEFAULT_NAME;
      if (node.type === 'JSXElement') {
        const e = node as JSXElement;
        slotName = getJSXAttribute(e.openingElement, SLOT_NAME_ATTR) || SLOT_DEFAULT_NAME;
      }
      const slot = slots[slotName];
      if (!slot) {
        //TODO: error
      } else {
        // slot.node.children.push(node);
        const i = slot.parent.children.indexOf(slot.node);
        slot.parent.children.splice(i, 0, node);
      }
    }
    if (!removeSlots) {
      return slots;
    }
    for (let key of Reflect.ownKeys(slots) as string[]) {
      const slot = slots[key];
      const i = slot.parent.children.indexOf(slot.node);
      slot.parent.children.splice(i, 1, ...slot.node.children);
    }
    return {};
  }

  addDefaultSlot(node: JSXElement): { node: JSXElement, parent: JSXElement } {
    const defaultSlot: JSXElement = {
      type: 'JSXElement',
      openingElement: {
        type: 'JSXOpeningElement',
        name: {
          type: 'JSXIdentifier',
          name: SLOT_TAG,
          start: node.start, end: node.end, loc: node.loc
        },
        attributes: [{
          type: 'JSXAttribute',
          name: {
            type: 'JSXIdentifier',
            name: SLOT_NAME_ATTR,
            start: node.start, end: node.end, loc: node.loc
          },
          value: {
            type: 'Literal',
            value: SLOT_DEFAULT_NAME,
            start: node.start, end: node.end, loc: node.loc
          },
          start: node.start, end: node.end, loc: node.loc
        }],
        selfClosing: false,
        start: node.start, end: node.end, loc: node.loc
      },
      closingElement: {
        type: 'JSXClosingElement',
        name: {
          type: 'JSXIdentifier',
          name: SLOT_TAG,
          start: node.start, end: node.end, loc: node.loc
        },
        start: node.start, end: node.end, loc: node.loc
      },
      children: [],
      start: node.start, end: node.end, loc: node.loc
    }
    node.children.push(defaultSlot);
    return { node: defaultSlot, parent: node };
  }
}
