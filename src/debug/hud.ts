/**
 * Perf HUD.
 *
 * Lines are supplied by a registry rather than hardcoded, because the master
 * plan requires every new subsystem to add a HUD line. A registry means Phase 1
 * registers "chunks" and "worker queue" without editing this file, and the same
 * holds for every phase after it.
 *
 * The HUD is hidden by `?hud=0`, and every canonical screenshot forces that.
 * fps and heap can never match between two runs, so a visible HUD would make
 * byte-identical screenshots impossible.
 */

export type HudValue = string | number;
export type HudProvider = () => HudValue;

/** Suggested sort keys, so unrelated phases do not fight over line order. */
export const HudOrder = {
  frame: 10,
  render: 20,
  memory: 30,
  world: 40,
  workers: 50,
  misc: 90,
} as const;

interface HudLine {
  label: string;
  provider: HudProvider;
  order: number;
  sequence: number;
}

export interface HudOptions {
  visible: boolean;
  /** How often the text is rebuilt, in Hz. Deliberately slow: unreadable otherwise. */
  updateHz: number;
}

const DEFAULT_OPTIONS: HudOptions = { visible: true, updateHz: 6 };

export class Hud {
  private readonly element: HTMLElement;
  private readonly lines = new Map<string, HudLine>();
  private readonly interval: number;

  private sequence = 0;
  private sinceUpdate = Number.POSITIVE_INFINITY;
  private isVisible: boolean;

  constructor(element: HTMLElement, options: Partial<HudOptions> = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    this.element = element;
    this.interval = 1 / opts.updateHz;
    this.isVisible = opts.visible;
    this.element.hidden = !opts.visible;
  }

  /**
   * Add a line. Returns a disposer so a subsystem can clean up after itself.
   * Registering the same label twice replaces the previous provider.
   */
  register(label: string, provider: HudProvider, order: number = HudOrder.misc): () => void {
    this.lines.set(label, { label, provider, order, sequence: this.sequence++ });
    return () => {
      this.lines.delete(label);
    };
  }

  setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.element.hidden = !visible;
  }

  get visible(): boolean {
    return this.isVisible;
  }

  /** Call once per frame with the wall-clock delta in seconds. */
  update(wallDt: number): void {
    if (!this.isVisible) return;

    this.sinceUpdate += wallDt;
    if (this.sinceUpdate < this.interval) return;
    this.sinceUpdate = 0;

    this.element.textContent = this.render();
  }

  /** Current HUD text. Exposed for tests and for `window.__app.hudText()`. */
  render(): string {
    const ordered = [...this.lines.values()].sort(
      (a, b) => a.order - b.order || a.sequence - b.sequence,
    );

    let width = 0;
    for (const line of ordered) width = Math.max(width, line.label.length);

    return ordered
      .map((line) => `${line.label.padEnd(width)}  ${formatValue(readSafely(line))}`)
      .join('\n');
  }
}

function readSafely(line: HudLine): HudValue {
  try {
    return line.provider();
  } catch {
    // A broken provider must not take the whole HUD down -- the HUD is the
    // debugging tool of last resort.
    return 'err';
  }
}

function formatValue(value: HudValue): string {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return 'n/a';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Group digits so six-figure triangle counts stay readable. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/**
 * JS heap in MB, or null where the browser does not expose it. Chrome-only and
 * coarse, but it is the only in-page signal for the "<=400MB after 5 minutes"
 * budget, and a leak shows up as a trend rather than an exact figure.
 */
export function readHeapMb(): number | null {
  const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
  if (memory === undefined) return null;
  return memory.usedJSHeapSize / (1024 * 1024);
}
