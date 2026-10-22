// One ECharts instance in React (ADR-0022, ADR-0028): SVG, sized by its container, rebuilt when the theme changes
// (colours are tokens read at build time). The element is a labelled image; every chart on the page also has a
// table, so nothing is shown by the chart alone.
import { useEffect, useRef, useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { echarts } from '@/components/charts/evilcharts-base';

/** Bumps when the document's theme class changes, so charts re-read their colour tokens. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setVersion((current) => current + 1);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
    };
  }, []);
  return version;
}

export interface EChartProps {
  /** What the chart shows, in words (its accessible name). */
  readonly label: string;
  /** Builds the option from the current tokens; called again when the theme changes. */
  readonly build: () => EChartsCoreOption;
  readonly height: number;
}

export function EChart({ label, build, height }: EChartProps) {
  const element = useRef<HTMLDivElement>(null);
  const theme = useThemeVersion();
  useEffect(() => {
    const node = element.current;
    if (node === null) return undefined;
    const chart = echarts.init(node, undefined, { renderer: 'svg' });
    chart.setOption(build(), true);
    // Follows its container's width (where the browser can tell it).
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            chart.resize();
          });
    resize?.observe(node);
    return () => {
      resize?.disconnect();
      chart.dispose();
    };
  }, [build, theme]);
  return <div ref={element} role="img" aria-label={label} style={{ height }} className="w-full" />;
}
