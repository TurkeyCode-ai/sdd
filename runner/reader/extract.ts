// Reads the rendered page into text blocks with positions. Runs in the real
// browser at the persona's viewport, so the layout is what a visitor gets.

import type { Page } from 'playwright';
import type { Block } from './skim.ts';

export interface PageLayout {
  blocks: Block[];
  pageHeight: number;
  viewportHeight: number;
}

export async function extractLayout(page: Page): Promise<PageLayout> {
  return page.evaluate(() => {
    const isBlock = (el: Element): boolean => {
      if (el instanceof SVGElement) return el.tagName.toLowerCase() === 'text';
      const display = getComputedStyle(el).display;
      return !display.startsWith('inline') && display !== 'contents';
    };

    // Group every visible text node under its nearest block-level ancestor.
    const groups = new Map<Element, string[]>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      let el = node.parentElement;
      if (!el || el.closest('script, style, noscript, template')) continue;
      while (el && !isBlock(el)) el = el.parentElement;
      if (!el) continue;
      const list = groups.get(el) ?? [];
      list.push(text);
      groups.set(el, list);
    }

    const elements = [...groups.keys()];
    const bodyFontSize = parseFloat(getComputedStyle(document.body).fontSize);
    const blocks: { kind: 'heading' | 'body'; section: string; text: string; top: number; bottom: number; left: number }[] = [];
    for (const el of elements) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;

      // innerText gets spacing and text-transform right, but would swallow
      // nested blocks. Use it only when this block has none.
      const hasNested = elements.some((other) => other !== el && el.contains(other));
      const text =
        !hasNested && el instanceof HTMLElement
          ? el.innerText.replace(/\s+/g, ' ').trim()
          : groups.get(el)!.join(' ');
      if (!text) continue;

      // A heading is what a skimmer's eye lands on: a heading tag, or text set
      // clearly larger than body text (a hero line, a styled <dt>).
      const isHeading =
        Boolean(el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')) ||
        (el instanceof HTMLElement && parseFloat(style.fontSize) >= bodyFontSize * 1.25);

      // Mark the element so screenshots can blur body text (see captureScreens).
      el.setAttribute('data-sdd-kind', isHeading ? 'heading' : 'body');

      const region = el.closest('section[id], header, footer, nav, aside');
      blocks.push({
        kind: isHeading ? 'heading' : 'body',
        section: region ? region.id || region.tagName.toLowerCase() : 'page',
        text,
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
      });
    }

    return {
      blocks: blocks.map((b, id) => ({ id, ...b })),
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
}

export interface Screen {
  scrollY: number;
  mediaType: 'image/jpeg';
  base64: string;
  width: number;
  height: number;
}

/**
 * Screenshots of the page at each scroll position, for the persona's visual
 * impression: layout, imagery, color, what stands out.
 *
 * Body text is blurred first. A model can read body text in a screenshot
 * down to about 150 pixels wide, so shrinking alone does not preserve the
 * skim: the reader would take in every word on screen. Headings stay sharp,
 * since a skimmer takes those in anyway. What the reader read of the body
 * comes from the skim, as text. Call after extractLayout, which marks the
 * elements.
 */
export async function captureScreens(page: Page, scrollYs: number[], maxWidth: number): Promise<Screen[]> {
  await page.addStyleTag({ content: '[data-sdd-kind="body"] { filter: blur(6px) !important; }' });
  const shots: { scrollY: number; b64: string }[] = [];
  for (const scrollY of scrollYs) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    const shot = await page.screenshot({ type: 'jpeg', quality: 80, scale: 'css' });
    shots.push({ scrollY, b64: shot.toString('base64') });
  }
  // Shrink in the browser. A data URL makes no network request.
  return page.evaluate(
    async ({ shots, maxWidth }) => {
      const out = [];
      for (const { scrollY, b64 } of shots) {
        const img = new Image();
        img.src = 'data:image/jpeg;base64,' + b64;
        await img.decode();
        const width = Math.min(maxWidth, img.width);
        const height = Math.round((img.height * width) / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d')!;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, width, height);
        out.push({ scrollY, mediaType: 'image/jpeg' as const, base64: canvas.toDataURL('image/jpeg', 0.75).split(',')[1]!, width, height });
      }
      return out;
    },
    { shots, maxWidth },
  );
}
