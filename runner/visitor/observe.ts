// What a visitor can see and act on, on the current screen.

import type { Page } from 'playwright';

export interface ScreenElement {
  /** Number the visitor refers to. Matches the data-sdd-el attribute on the page. */
  n: number;
  kind: 'link' | 'button' | 'input' | 'select' | 'checkbox';
  /** What it says: its text, label, or placeholder. */
  label: string;
  /** For inputs: text, email, password, and so on. */
  inputType?: string;
  /** For inputs: what is typed in it now. */
  value?: string;
  /** For links: where it goes. "outside" when it leaves the app. */
  goesTo?: 'same page' | 'another page' | 'outside';
  width: number;
  height: number;
}

export interface ScreenText {
  kind: 'heading' | 'body';
  text: string;
}

export interface Observation {
  url: string;
  title: string;
  scrollY: number;
  viewportHeight: number;
  pageHeight: number;
  /** Text blocks at least half on screen, in reading order. */
  text: ScreenText[];
  /** Things that can be clicked or typed into, at least half on screen. */
  elements: ScreenElement[];
}

export async function observe(page: Page): Promise<Observation> {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const onScreen = (r: DOMRect) => r.width > 0 && r.height > 0 && r.top + r.height / 2 >= 0 && r.top + r.height / 2 <= vh;
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

    // Text, with the same notion of "heading" the reader uses.
    const bodySize = parseFloat(getComputedStyle(document.body).fontSize);
    const text: { kind: 'heading' | 'body'; text: string; top: number }[] = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!clean(node.textContent)) continue;
      let el = node.parentElement;
      if (!el || el.closest('script, style, noscript, template, button, a, label, select, option')) continue;
      while (el && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
      if (!el || seen.has(el) || !visible(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (!onScreen(rect)) continue;
      const own = clean((el as HTMLElement).innerText);
      if (!own) continue;
      const heading = Boolean(el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')) || parseFloat(getComputedStyle(el).fontSize) >= bodySize * 1.25;
      text.push({ kind: heading ? 'heading' : 'body', text: own.slice(0, 600), top: rect.top });
    }
    text.sort((a, b) => a.top - b.top);

    // Things to act on.
    document.querySelectorAll('[data-sdd-el]').forEach((el) => el.removeAttribute('data-sdd-el'));
    const elements: ScreenElement[] = [];
    const candidates = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]');
    for (const el of candidates) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (!onScreen(rect)) continue;
      const input = el as HTMLInputElement;
      if (el.tagName === 'INPUT' && ['hidden', 'file'].includes(input.type)) continue;
      if (input.disabled) continue;

      let kind: ScreenElement['kind'] = 'button';
      if (el.tagName === 'A' || el.getAttribute('role') === 'link') kind = 'link';
      else if (el.tagName === 'SELECT') kind = 'select';
      else if (el.tagName === 'TEXTAREA') kind = 'input';
      else if (el.tagName === 'INPUT') kind = ['checkbox', 'radio'].includes(input.type) ? 'checkbox' : ['submit', 'button', 'reset'].includes(input.type) ? 'button' : 'input';

      const labelled = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const label =
        clean(el.getAttribute('aria-label')) ||
        clean(labelled?.textContent) ||
        clean(el.closest('label')?.textContent) ||
        clean((el as HTMLElement).innerText) ||
        clean(input.value && kind === 'button' ? input.value : '') ||
        clean(el.getAttribute('placeholder')) ||
        clean(el.getAttribute('title')) ||
        clean(el.getAttribute('name')) ||
        '(no label)';

      const n = elements.length + 1;
      el.setAttribute('data-sdd-el', String(n));
      const item: ScreenElement = { n, kind, label: label.slice(0, 120), width: Math.round(rect.width), height: Math.round(rect.height) };
      if (kind === 'input') {
        item.inputType = el.tagName === 'TEXTAREA' ? 'text' : input.type || 'text';
        item.value = input.value;
      }
      if (kind === 'link') {
        const href = (el as HTMLAnchorElement).href;
        try {
          const url = new URL(href, location.href);
          item.goesTo = url.origin !== location.origin ? 'outside' : url.pathname === location.pathname ? 'same page' : 'another page';
        } catch {
          item.goesTo = 'same page';
        }
      }
      elements.push(item);
    }

    return {
      url: location.pathname + location.search,
      title: document.title,
      scrollY: Math.round(window.scrollY),
      viewportHeight: vh,
      pageHeight: document.documentElement.scrollHeight,
      text: text.map(({ kind, text }) => ({ kind, text })),
      elements,
    };
  });
}
