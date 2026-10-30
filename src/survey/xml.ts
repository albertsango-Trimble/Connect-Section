/** Small helpers for reading XML with the DOM, ignoring namespaces and letter case. */

export const elements = (parent: Element | Document): Element[] => {
  const out: Element[] = [];
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i] as Element);
  return out;
};

export const localName = (el: Element) => (el.localName ?? el.nodeName.replace(/^.*:/, '')).toLowerCase();

/** The first direct child element with this name (any case). */
export const child = (parent: Element | undefined | null, name: string): Element | undefined => {
  if (!parent) return undefined;
  const want = name.toLowerCase();
  return elements(parent).find((e) => localName(e) === want);
};

export const children = (parent: Element | undefined | null, name: string): Element[] => {
  if (!parent) return [];
  const want = name.toLowerCase();
  return elements(parent).filter((e) => localName(e) === want);
};

/** Text of a direct child element, trimmed; undefined when missing or empty. */
export const text = (parent: Element | undefined | null, name: string): string | undefined => {
  const t = child(parent, name)?.textContent?.trim();
  return t ? t : undefined;
};

export const num = (parent: Element | undefined | null, name: string): number | undefined => {
  const t = text(parent, name);
  if (t === undefined) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

/** An attribute or, failing that, a direct child element's text (any case), as FXL files use either. */
export const field = (el: Element, ...names: string[]): string | undefined => {
  for (const name of names) {
    const want = name.toLowerCase();
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a.name.replace(/^.*:/, '').toLowerCase() === want && a.value.trim()) return a.value.trim();
    }
    const t = text(el, name);
    if (t !== undefined) return t;
  }
  return undefined;
};

/** Every element in the document, depth first. */
export function* walk(root: Element): Generator<Element> {
  const stack: Element[] = [root];
  while (stack.length) {
    const el = stack.pop() as Element;
    yield el;
    const kids = elements(el);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

export function parseXml(source: string): Document {
  const doc = new DOMParser().parseFromString(source.replace(/^﻿/, ''), 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`not readable XML (${(error.textContent ?? '').trim().slice(0, 120)})`);
  return doc;
}
