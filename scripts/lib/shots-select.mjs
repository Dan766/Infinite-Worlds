/**
 * View selection and reload clustering for the canonical screenshot harness.
 *
 * `--only` filters which views run. Within a filtered list, consecutive views
 * that share every URL param except camera pose and wireframe form a cluster:
 * the first pays for a cold `page.goto`, the rest call `App.seekCamera` on the
 * same page so the streamer keeps its cache.
 */

/** Parse CLI flags shared by `shots` and `shots:check`. */
export function parseShotArgs(argv) {
  let build = true;
  /** @type {string[]} */
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-build') {
      build = false;
      continue;
    }
    if (a === '--only') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        only.push(...next.split(',').map((s) => s.trim()).filter(Boolean));
        i++;
      }
      continue;
    }
    if (a.startsWith('--only=')) {
      only.push(
        ...a
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }
  return { build, only };
}

/**
 * Glob match where `*` matches any run of characters (including empty / `/`).
 * Patterns are matched against the view name only.
 */
export function matchOnly(name, patterns) {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(name);
  });
}

export function filterViews(views, patterns) {
  if (patterns.length === 0) return views;
  const selected = views.filter((v) => matchOnly(v.name, patterns));
  if (selected.length === 0) {
    throw new Error(
      `no canonical views matched --only=${patterns.join(',')}. ` +
        `Known names: ${views.map((v) => v.name).join(', ')}`,
    );
  }
  return selected;
}

/**
 * Params that force a full navigation. Camera pose and wireframe can be
 * applied in-page via `seekCamera`.
 */
const RELOAD_PARAM_KEYS = [
  'seed',
  'time',
  // Phase 10. The unknown-key fallback below would already bucket `tod`
  // correctly, but the sky is the one thing a shared page would get wrong most
  // visibly, so it is named rather than left to a catch-all.
  'tod',
  'walk',
  'fly',
  'flyleg',
  // Anything else unexpected is treated as reload-forcing so a future param
  // cannot silently share a page with the wrong world state.
];

const IN_PAGE_PARAM_KEYS = new Set(['pos', 'look', 'wireframe', 'hud', 'panel', 'freeze']);

/**
 * Fingerprint of the world state a view needs loaded. Equal keys may share a
 * page; unequal keys must `page.goto`.
 */
export function reloadKey(params = '') {
  const q = new URLSearchParams(params.startsWith('?') ? params.slice(1) : params);
  const parts = [];
  for (const key of RELOAD_PARAM_KEYS) {
    if (q.has(key)) parts.push(`${key}=${q.get(key)}`);
  }
  // Unknown keys (not in-page, not in the known reload list) force a reload
  // bucket of their own so we never apply them via seekCamera.
  const unknown = [];
  for (const key of q.keys()) {
    if (IN_PAGE_PARAM_KEYS.has(key)) continue;
    if (RELOAD_PARAM_KEYS.includes(key)) continue;
    unknown.push(`${key}=${q.get(key)}`);
  }
  unknown.sort();
  parts.push(...unknown);
  return parts.join('&') || 'default';
}

/** Camera + wireframe state that `seekCamera` can apply without reloading. */
export function inPageCamera(params = '') {
  const q = new URLSearchParams(params.startsWith('?') ? params.slice(1) : params);
  const posParts = (q.get('pos') ?? '3.5,2.5,5.5').split(',').map(Number);
  const lookParts = (q.get('look') ?? '32.5,-21').split(',').map(Number);
  const wire = q.get('wireframe');
  return {
    pos: {
      x: posParts[0] ?? 3.5,
      y: posParts[1] ?? 2.5,
      z: posParts[2] ?? 5.5,
    },
    look: {
      yaw: lookParts[0] ?? 32.5,
      pitch: lookParts[1] ?? -21,
    },
    wireframe: wire === null ? false : !['0', 'false', 'no', 'off'].includes(wire.toLowerCase()),
  };
}

/**
 * Split a view list into consecutive clusters that may share one page load.
 * Order is preserved; non-consecutive same-key views are NOT merged (Phase 6a
 * process-history flakes made unordered capture unsafe).
 */
export function clusterViews(views) {
  /** @type {typeof views[]} */
  const clusters = [];
  for (const view of views) {
    const key = reloadKey(view.params ?? '');
    const last = clusters[clusters.length - 1];
    if (last !== undefined && last.key === key) {
      last.views.push(view);
    } else {
      clusters.push({ key, views: [view] });
    }
  }
  return clusters;
}