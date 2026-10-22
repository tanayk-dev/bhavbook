// From EvilCharts' `echarts-chart` base (MIT, https://evilcharts.com, registry item @evilcharts/echarts-chart; see
// SOURCE.md): the renderer registration and the color plumbing every chart shares, trimmed to what BhavBook's charts
// use and adapted to this repo's checks (strict optional types, RegExp#exec). ADR-0022, ADR-0028.
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

// One renderer for every chart: SVG is crisp at any zoom and needs no canvas.
echarts.use([SVGRenderer]);

export { echarts };

// A single reusable 1×1 canvas normalizes any CSS color (hex, named, oklch, a custom property's value) to a concrete
// rgba string by painting it and reading the pixel back; without a canvas the value passes through.
let normalizerContext: CanvasRenderingContext2D | null = null;

export function normalizeColor(value: string): string {
  const raw = value.trim();
  if (raw === '' || typeof document === 'undefined') return raw;
  if (normalizerContext === null) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    try {
      normalizerContext = canvas.getContext('2d', { willReadFrequently: true });
    } catch {
      normalizerContext = null;
    }
  }
  if (normalizerContext === null) return raw;
  normalizerContext.clearRect(0, 0, 1, 1);
  normalizerContext.fillStyle = '#000';
  // An invalid value leaves the sentinel in place.
  normalizerContext.fillStyle = raw;
  normalizerContext.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = normalizerContext.getImageData(0, 0, 1, 1).data;
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${(a / 255).toFixed(3)})`;
}

/**
 * Scales the alpha of an `rgba(r, g, b, a)` string. Multiplying (not replacing) keeps translucent tokens honest; a
 * color in another form passes through unchanged.
 */
export function withAlpha(color: string, alpha: number): string {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (match === null) return color;
  const [r, g, b, a] = (match[1] ?? '').split(',').map((part) => part.trim());
  const base = a === undefined ? 1 : Number.parseFloat(a) || 0;
  return `rgba(${r ?? '0'}, ${g ?? '0'}, ${b ?? '0'}, ${(base * alpha).toFixed(3)})`;
}

/** The current value of a CSS custom property on the document (a design token), normalized. */
export function token(name: string): string {
  if (typeof document === 'undefined') return '';
  return normalizeColor(getComputedStyle(document.documentElement).getPropertyValue(name));
}
