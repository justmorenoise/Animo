import type { DisplayRef, LibraryFolder, Node, Project } from "./types";
import { DEFAULT_MOTION_BLUR, DOC_VERSION, type MotionBlurSettings } from "./types";
import { observeId } from "./ids";
import { isDefaultExport, sanitizeExportSettings } from "@/core/export/settings";
import { normalizeMasks } from "./layerTree";
import { displaysOf } from "./displays";
import { CURVE_Y_LIMIT, EASE_FAMILIES, TWEEN_CHANNELS, TWEEN_LINEAR, type TweenSpec, } from "@/core/math/easing";

export interface Diagnostic {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  project: Project;
  diagnostics: Diagnostic[];
}

/**
 * Validate and repair a project loaded from disk.
 *
 * The guiding rule is that a damaged file should open with a warning and its
 * broken parts quarantined, not fail to open at all: losing a whole afternoon
 * of work to one dangling reference is far worse than losing the one layer
 * that reference belonged to.
 */
export function validateProject(raw: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const fail = (path: string, message: string): never => {
    throw new Error(`${path}: ${message}`);
  };

  if (!raw || typeof raw !== "object") fail("project", "not an object");
  const p = raw as Project;

  if (typeof p.version !== "number") fail("version", "missing");
  if (p.version > DOC_VERSION) {
    fail("version", `file is version ${p.version}, this build understands up to ${DOC_VERSION}`);
  }
  if (!p.items || typeof p.items !== "object") fail("items", "missing");
  if (!p.rootSymbolId || !p.items[p.rootSymbolId]) fail("rootSymbolId", "does not name a symbol");

  p.name = typeof p.name === "string" && p.name ? p.name : "Untitled";
  p.frameRate = clampInt(p.frameRate, 1, 120, 24);
  p.stage = {
    width: clampInt(p.stage?.width, 1, 16384, 800),
    height: clampInt(p.stage?.height, 1, 16384, 600),
    background: typeof p.stage?.background === "string" ? p.stage.background : "#ffffff",
  };
  if (p.motionBlur !== undefined) {
    const mb = p.motionBlur as Partial<MotionBlurSettings> | null;
    p.motionBlur = {
      enabled: mb?.enabled === true,
      shutter: clampInt(mb?.shutter, 0, 360, DEFAULT_MOTION_BLUR.shutter),
      maxLength: clampInt(mb?.maxLength, 1, 4096, DEFAULT_MOTION_BLUR.maxLength),
    };
  }
  if (p.exportSettings !== undefined) {
    const settings = sanitizeExportSettings(p.exportSettings);
    if (isDefaultExport(settings)) delete p.exportSettings;
    else p.exportSettings = settings;
  }
  p.folders = repairFolders(p, diagnostics);
  p.itemOrder = Array.isArray(p.itemOrder) ? p.itemOrder.filter((id) => !!p.items[id]) : [];
  for (const id of Object.keys(p.items)) {
    observeId(id);
    if (!p.itemOrder.includes(id as never)) p.itemOrder.push(id as never);
  }

  for (const item of Object.values(p.items)) {
    if (item.folderId !== undefined && (typeof item.folderId !== "string" || !p.folders[item.folderId])) {
      delete item.folderId;
    }
  }

  for (const [itemId, item] of Object.entries(p.items)) {
    if (item.kind === "image") {
      item.width = clampInt(item.width, 1, 16384, 1);
      item.height = clampInt(item.height, 1, 16384, 1);
      continue;
    }
    if (item.kind !== "symbol") {
      diagnostics.push({ path: `items.${itemId}`, message: "unknown item kind, ignored", severity: "warning" });
      continue;
    }

    item.nodes ??= {};
    item.layers ??= [];
    item.ik ??= [];
    item.animations ??= [];

    for (const nodeId of Object.keys(item.nodes)) observeId(nodeId);

    // Drop layers whose node vanished, and nodes with no layer: the one-node
    // one-layer rule is what makes slot ordering unambiguous.
    const before = item.layers.length;
    item.layers = item.layers.filter((l) => {
      observeId(l.id);
      return !!item.nodes[l.nodeId];
    });
    if (item.layers.length !== before) {
      diagnostics.push({
        path: `items.${itemId}.layers`,
        message: `${before - item.layers.length} layer(s) referenced a missing object and were removed`,
        severity: "warning",
      });
    }
    const layered = new Set(item.layers.map((l) => l.nodeId));
    const remapped = new Map<string, Map<number, number>>();
    for (const nodeId of Object.keys(item.nodes)) {
      if (!layered.has(nodeId as never)) delete item.nodes[nodeId as never];
    }

    // Break parent links that point nowhere or close a loop.
    for (const node of Object.values(item.nodes)) {
      if (node.parentId && !item.nodes[node.parentId]) node.parentId = null;
      if (node.parentId && hasCycle(item.nodes, node.id)) {
        node.parentId = null;
        diagnostics.push({
          path: `items.${itemId}.nodes.${node.id}`,
          message: "parent chain looped back on itself; the link was cut",
          severity: "warning",
        });
      }
      if (node.itemId && !p.items[node.itemId]) {
        diagnostics.push({
          path: `items.${itemId}.nodes.${node.id}`,
          message: `"${node.name}" points at a library item that is not in the file`,
          severity: "warning",
        });
      }
      node.pivot ??= { x: 0, y: 0 };
      if (node.extraDisplays !== undefined) {
        const extras = node.itemId && Array.isArray(node.extraDisplays)
          ? node.extraDisplays.filter((d) => d && !!p.items[d.itemId]) : [];
        const dropped = (Array.isArray(node.extraDisplays) ? node.extraDisplays.length : 0) - extras.length;
        if (dropped > 0) {
          diagnostics.push({
            path: `items.${itemId}.nodes.${node.id}`,
            message: `"${node.name}" had ${dropped} display(s) without a library item; they were dropped`,
            severity: "warning",
          });
        }
        for (const d of extras) {
          d.pivot = { x: finiteOr(d.pivot?.x, 0), y: finiteOr(d.pivot?.y, 0) };
        }
        // Keys are remapped below, once the tracks are read: the old indices
        // are needed to tell which display each one meant.
        if (dropped > 0) remapped.set(node.id, remapFor(node, extras));
        if (extras.length) node.extraDisplays = extras;
        else delete node.extraDisplays;
      }
      if (node.motionBlur !== undefined) {
        const m = Number(node.motionBlur);
        if (!Number.isFinite(m) || m === 1) delete node.motionBlur;
        else node.motionBlur = Math.max(0, Math.min(2, m));
      }
    }

    if (item.animations.length === 0) {
      diagnostics.push({
        path: `items.${itemId}.animations`,
        message: "no animations; an empty one was added so the armature can play",
        severity: "warning",
      });
      item.animations.push({
        id: `a_recovered_${itemId}` as never,
        name: "animation", duration: 1, playTimes: 0, tracks: {},
      });
    }

    for (const anim of item.animations) {
      observeId(anim.id);
      anim.duration = clampInt(anim.duration, 1, 100000, 1);
      anim.playTimes = clampInt(anim.playTimes, 0, 10000, 0);
      anim.tracks ??= {};
      for (const [nodeId, track] of Object.entries(anim.tracks)) {
        if (!item.nodes[nodeId as never] || !track?.keys?.length) {
          delete anim.tracks[nodeId as never];
          continue;
        }
        track.keys.sort((a, b) => a.frame - b.frame);
        // Two keys on one frame break every lookup in the frame algebra. An
        // older build wrote them when a keyframe was dropped onto another.
        const unique = track.keys.filter((k, i, all) => i === 0 || k.frame !== all[i - 1]!.frame);
        if (unique.length !== track.keys.length) {
          diagnostics.push({
            path: `items.${itemId}.animations.${anim.id}.tracks.${nodeId}`,
            message: `${track.keys.length - unique.length} keyframe(s) shared the same frame as another and were dropped`,
            severity: "warning",
          });
          track.keys = unique;
        }
        track.endFrame = Math.max(track.endFrame ?? 0, track.keys[track.keys.length - 1]!.frame);
        const node = item.nodes[nodeId as never]!;
        const displays = displaysOf(node).length;
        const remap = remapped.get(node.id);
        let blanked = 0;
        for (const k of track.keys) {
          const d = Number(k.displayIndex ?? 0);
          k.displayIndex = Number.isInteger(d) && d >= -1 ? d : 0;
          if (remap && k.displayIndex > 0) k.displayIndex = remap.get(k.displayIndex) ?? -1;
          if (k.displayIndex >= Math.max(1, displays)) { k.displayIndex = -1; blanked++; }
          k.tween = sanitizeTween(k.tween) ?? TWEEN_LINEAR;
          if (k.eases !== undefined) {
            const eases: Record<string, unknown> = {};
            for (const ch of TWEEN_CHANNELS) {
              const e = sanitizeTween((k.eases as Record<string, unknown>)?.[ch]);
              if (e && e.kind !== "none") eases[ch] = e;
            }
            if (Object.keys(eases).length) k.eases = eases as typeof k.eases;
            else delete k.eases;
          }
          if (k.rotateDir !== undefined && k.rotateDir !== "cw" && k.rotateDir !== "ccw") delete k.rotateDir;
          if (k.rotateTurns !== undefined) {
            const turns = Math.round(Number(k.rotateTurns));
            if (Number.isFinite(turns) && turns !== 0) k.rotateTurns = turns;
            else delete k.rotateTurns;
          }
        }
        if (blanked) {
          diagnostics.push({
            path: `items.${itemId}.animations.${anim.id}.tracks.${nodeId}`,
            message: `${blanked} keyframe(s) showed a display the layer does not have; they are blank now`,
            severity: "warning",
          });
        }
      }
      // The exporter's frame durations add up to `duration`, so a span that
      // runs past it would leave the file claiming a shorter animation than
      // its own timelines.
      const reach = Math.max(-1, ...Object.values(anim.tracks).map((t) => t?.endFrame ?? -1)) + 1;
      if (reach > anim.duration) {
        diagnostics.push({
          path: `items.${itemId}.animations.${anim.id}`,
          message: `"${anim.name}" was ${anim.duration} frame(s) long but keyed to frame ${reach - 1}; it now lasts ${reach}`,
          severity: "warning",
        });
        anim.duration = reach;
      }
    }

    // An IK constraint pointing at a missing bone would crash the exporter.
    item.ik = item.ik.filter((k) => !!item.nodes[k.boneId] && !!item.nodes[k.targetId]);
    for (const k of item.ik) observeId(k.id);
    const masks = normalizeMasks(item).masks.size;
    if (masks) {
      diagnostics.push({
        path: `items.${itemId}.layers`,
        message: `${masks} layer(s) had a mask setting that could not work (a missing or misplaced mask, or a mask with nothing to clip); it was cleared`,
        severity: "warning",
      });
    }
  }

  p.version = DOC_VERSION;
  return { project: p, diagnostics };
}

/**
 * True when `start` is ON a parent loop. A chain that merely runs into a loop
 * further up (A → B → C → B) is not: cutting A would lose a valid link, and
 * the loop itself is cut when its own members are checked.
 */
export function hasCycle(nodes: Record<string, { id: string; parentId: string | null }>, start: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = nodes[start]?.parentId ?? null;
  while (cur) {
    if (cur === start) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = nodes[cur]?.parentId ?? null;
  }
  return false;
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Old display index → new, after dropping the extra displays not in `kept`. */
function remapFor(node: Node, kept: DisplayRef[]): Map<number, number> {
  const out = new Map<number, number>();
  (node.extraDisplays ?? []).forEach((d, i) => {
    const j = kept.indexOf(d);
    if (j >= 0) out.set(i + 1, j + 1);
  });
  return out;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Version bridge. There is one entry today; it exists from day one so that
 * adding the second is a two-line change rather than a redesign.
 */
const MIGRATIONS: Record<number, (p: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 -> 1: files written before the version field existed.
  0: (p) => ({ ...p, version: 1 }),
  // 1 -> 2: mask layers. Purely additive — an absent `isMask`/`maskedBy`
  // reads as "no masks" — but the version moves so an older build refuses
  // the file rather than opening it and silently drawing without the clip.
  1: (p) => ({ ...p, version: 2 }),
  // 2 -> 3: `Layer.excludeFromExport` and the "empty" node kind. Additive
  // again, and again the version moves: an older build would happily export
  // the very content the user marked as excluded.
  2: (p) => ({ ...p, version: 3 }),
  // 3 -> 4: motion blur (`Project.motionBlur`, `Node.motionBlur`). Additive;
  // an older build would drop the settings on save without saying so.
  3: (p) => ({ ...p, version: 4 }),
  // 4 -> 5: preset and multi-segment eases, per-property `Keyframe.eases`.
  // An older build has no evaluator for either and would tween to NaN.
  4: (p) => ({ ...p, version: 5 }),
  // 5 -> 6: `Node.extraDisplays`, artwork switched per keyframe. An older
  // build would draw display 0 on every key and export it that way.
  5: (p) => ({ ...p, version: 6 }),
  // 6 -> 7: `Project.exportSettings`. Additive; an older build would export
  // at its own defaults and drop the settings on save.
  6: (p) => ({ ...p, version: 7 }),
};

/** A tween read from disk, or null when it is not one this build knows. */
function sanitizeTween(raw: unknown): TweenSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  switch (t.kind) {
    case "none":   return { kind: "none" };
    case "linear": return { kind: "linear" };
    case "ease":
      return finite(t.value) ? { kind: "ease", value: Math.min(2, Math.max(-1, t.value)) } : null;
    case "curve": {
      const c = t.curve;
      if (!Array.isArray(c) || c.length < 4 || c.length % 6 !== 4 || !c.every(finite)) return null;
      return { kind: "curve", curve: c.map((v, i) => (i % 2 ? Math.min(CURVE_Y_LIMIT, Math.max(-CURVE_Y_LIMIT, v)) : Math.min(1, Math.max(0, v)))) };
    }
    case "preset": {
      const fam = EASE_FAMILIES.find((f) => f.id === t.family);
      if (!fam || (t.dir !== "in" && t.dir !== "out" && t.dir !== "inOut")) return null;
      const spec: TweenSpec = { kind: "preset", family: fam.id, dir: t.dir };
      if (fam.amount && finite(t.amount)) spec.amount = Math.min(fam.amount.max, Math.max(fam.amount.min, t.amount));
      return spec;
    }
    default: return null;
  }
}

export function migrate(raw: unknown): unknown {
  let p = raw as Record<string, unknown>;
  let version = typeof p?.version === "number" ? p.version : 0;
  while (version < DOC_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    p = step(p);
    version = typeof p.version === "number" ? p.version : version + 1;
  }
  return p;
}

/**
 * Library folders: malformed entries dropped, a parent that does not exist
 * or closes a loop cut to the top level. Folders only organise the library,
 * so a repair never touches an item beyond moving it to the top level.
 */
function repairFolders(p: Project, diagnostics: Diagnostic[]): Project["folders"] {
  const raw = (p.folders && typeof p.folders === "object" ? p.folders : {}) as Record<string, unknown>;
  const out: Project["folders"] = {};
  for (const [key, value] of Object.entries(raw)) {
    const f = value as Partial<LibraryFolder> | null;
    if (!f || typeof f !== "object" || f.id !== key || typeof f.name !== "string") {
      diagnostics.push({ path: `folders.${key}`, message: "malformed library folder, removed", severity: "warning" });
      continue;
    }
    observeId(f.id);
    out[f.id] = { id: f.id, name: f.name, parentId: typeof f.parentId === "string" ? f.parentId : null };
  }
  for (const f of Object.values(out)) {
    if (f.parentId && !out[f.parentId]) f.parentId = null;
    let at = f.parentId;
    for (let n = 0; at && n <= Object.keys(out).length; n++) {
      if (at === f.id) {
        f.parentId = null;
        diagnostics.push({
          path: `folders.${f.id}`,
          message: "library folder was inside itself; moved to the top level",
          severity: "warning",
        });
        break;
      }
      at = out[at]?.parentId ?? null;
    }
  }
  return out;
}

