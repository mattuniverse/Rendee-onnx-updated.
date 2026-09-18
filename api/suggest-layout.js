// /api/suggest-layout.js — deterministic room-layout rules engine
//
// No LLM dependency: generates a layout in code (no Anthropic call, no API key).
// Layered rule concerns:
//   Layer 1 — architectural rules   (door swing, walkway, egress, structural clearance)
//   Layer 2 — engineering rules     (kitchen outlet proximity, bathroom wet-zone cluster)
//   Layer 3 — interior design rules (seating groups, TV distance, work triangle, spacing)
//   Layer 4 — deterministic post-processing (grid snap, wall align, mirror pairs)
//   Layer 5 — hard safety checks    (nursery crib-to-window, window egress) → 422
//
// Response schema:
//   { layout, suggestions, notes, rulesApplied, disclaimer }

import {
  DISCLAIMER,
  EGRESS_ROOM_TYPES,
  ENGINEERING_SKIP_TYPES,
  BED_IDS,
  DOUBLE_BED_IDS,
  DEFAULT_SILL_HEIGHT,
  DEFAULT_WALKWAY,
  STRUCTURAL_CLEARANCE,
  SIZES,
  HEIGHTS,
  WALKWAY_BY_TYPE,
  ROLES,
  PASSIVE_IDS,
  CLEARANCE_RULES,
  ANCHOR_ORDER,
} from '../shared/rules.js';

function key(t) {
  return String(t || "").trim().toLowerCase();
}

function sizeFor(id) {
  return SIZES[id] || [0.8, 0.8];
}

function heightFor(id) {
  return typeof HEIGHTS[id] === "number" ? HEIGHTS[id] : 0.6;
}

function rectangularsOverlap(a, b) {
  return !(a.x >= b.x + b.w || a.x + a.w <= b.x || a.y >= b.y + b.h || a.y + a.h <= b.y);
}

// deterministic pseudo-random (mulberry32) for stable tie-breaking
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function snapToGrid(x, y, grid = 0.05) {
  const gx = Math.round(x / grid) * grid;
  const gy = Math.round(y / grid) * grid;
  return [Math.round(gx * 1000) / 1000, Math.round(gy * 1000) / 1000];
}

function clampToRoom(item, w, h) {
  const [iw, ih] = sizeFor(item.furnitureId);
  item.x = Math.min(Math.max(0, item.x), Math.max(0, w - iw));
  item.y = Math.min(Math.max(0, item.y), Math.max(0, h - ih));
}

// Flush an item's edge against the room boundary it is within `tolerance` of.
// Wall geometry is not in the payload so the four room edges act as the wall set.
function alignToWall(item, w, h, tolerance = 0.02) {
  const [iw, ih] = sizeFor(item.furnitureId);
  const dists = [
    { axis: "x", val: 0, d: item.x },
    { axis: "x", val: Math.max(0, w - iw), d: Math.abs(w - iw - item.x) },
    { axis: "y", val: 0, d: item.y },
    { axis: "y", val: Math.max(0, h - ih), d: Math.abs(h - ih - item.y) },
  ];
  let best = null;
  dists.forEach((c) => {
    if (c.d <= tolerance && (!best || c.d < best.d)) best = c;
  });
  if (!best) return false;
  if (best.axis === "x") item.x = best.val;
  else item.y = best.val;
  return true;
}

function centerOf(item) {
  const [iw, ih] = sizeFor(item.furnitureId);
  return { cx: item.x + iw / 2, cy: item.y + ih / 2 };
}

// Force symmetric pairs (e.g. nightstands) to mirror around an anchor's centerline.
function mirrorPairs(items, pairConfig) {
  let applied = 0;
  (pairConfig || []).forEach((cfg) => {
    const a = items.find((i) => i.furnitureId === cfg.leftId);
    const b = items.find((i) => i.furnitureId === cfg.rightId);
    if (!a || !b) return;
    const anchor = cfg.anchorId ? items.find((i) => i.furnitureId === cfg.anchorId) : null;
    const ac = centerOf(a);
    const bc = centerOf(b);
    const cx = anchor ? centerOf(anchor).cx : (ac.cx + bc.cx) / 2;
    const cy = anchor ? centerOf(anchor).cy : (ac.cy + bc.cy) / 2;
    const [bw, bh] = sizeFor(b.furnitureId);
    if (cfg.axis === "y") {
      b.y = 2 * cy - ac.cy - bh / 2;
      b.x = a.x;
    } else {
      b.x = 2 * cx - ac.cx - bw / 2;
      b.y = a.y;
    }
    applied++;
  });
  return applied;
}

// get a rect for an already-placed item
function rectOf(item) {
  const [iw, ih] = sizeFor(item.furnitureId);
  return { x: item.x, y: item.y, w: iw, h: ih, furnitureId: item.furnitureId };
}

function structuralItems(furniture) {
  let doors = [], windows = [];
  (furniture || []).forEach((f) => {
    const id = key(f.furnitureId);
    if (id === "door") doors.push(f);
    else if (id === "window") windows.push(f);
  });
  return { doors, windows };
}

// ─────────────────────────────────────────────────────────────
//  DOMAIN RULE MODULES (report which fired → prompt-style text)
// ─────────────────────────────────────────────────────────────
function architecturalRuleText(roomType, doors, windows, w, h) {
  const walkway = WALKWAY_BY_TYPE[key(roomType)] || DEFAULT_WALKWAY;
  const egress = EGRESS_ROOM_TYPES.includes(key(roomType));
  const fired = ["architectural.door_swing", "architectural.walkway"];
  if (egress) fired.push("architectural.egress");
  if (STRUCTURAL_CLEARANCE) fired.push("architectural.structural_clearance");
  return {
    fired,
    text: `## Architectural rules\n- Door swing clearance: unobstructed arc of radius = door width (default 0.9m); no furniture inside arcs.\n- Minimum walkway: ${walkway}m clear path between pieces.\n${egress ? `- Window egress required: no furniture taller than sill (${DEFAULT_SILL_HEIGHT}m) blocking window fronts (extend ${Math.max(1.2, walkway)}m into room).` : `- Keep window fronts accessible; nothing taller than sill height (${DEFAULT_SILL_HEIGHT}m) in front of windows.\n`}- Keep at least ${STRUCTURAL_CLEARANCE}m between any furniture edge and doors/windows.\n${doors.length ? "" : "- No doors provided; assume a door on each wall for swing arcs."}${windows.length ? "" : "- No windows provided; keep tall furniture off the perimeter."}`,
  };
}

function engineeringRuleText(roomType) {
  const t = key(roomType);
  if (ENGINEERING_SKIP_TYPES.includes(t)) return { fired: [], text: "" };
  if (t === "kitchen" || t === "kitchenette") {
    return {
      fired: ["engineering.outlet_proximity"],
      text: `## Engineering rules\n- Kitchen outlet proximity: appliances that draw power must sit within 60cm of a wall face (ASSUMPTION: outlets are standard wall-mounted; no outlet coordinates are known yet).\n- Keep appliances spread so no wall section is overloaded.`,
    };
  }
  if (t === "bathroom" || t === "bath") {
    return {
      fired: ["engineering.wet_zone_cluster"],
      text: `## Engineering rules\n- Bathroom wet-zone clustering: sink, toilet, and shower/bath must sit within 2m of each other to share plumbing.`,
    };
  }
  return { fired: [], text: "" };
}

function interiorRuleText(roomType, roomStyle) {
  const t = key(roomType);
  const fired = [];
  let base = "";
  const m = {
    bedroom: "Bed anchoring, nightstands flanking, wardrobe near entrance.",
    "living room": "Seating group facing the focal/TV wall (2.5-3.5m viewing distance), coffee table 0.4m in front of sofa.",
    "dining room": "Table centered; chairs spaced around all sides.",
    "home office": "Desk facing a wall; chair behind with 0.9m clearance.",
    kitchen: "Compact sink-stove-fridge work triangle, legs 1.2-2.7m.",
    "wheelchair friendly": "1.2m paths, 1.5m turning radius, furniture against walls.",
    "elderly friendly": "0.9m straight paths, seating near the entrance, no sharp corners.",
    "studio apartment": "Three zones: sleep, work(desk near window), lounge; 0.9m between zones.",
    nursery: "Crib ≥0.9m from all windows; changing table near the door.",
  };
  base = m[t] || "Sensible placement with 0.6-0.9m comfortable clearances.";
  const egress = EGRESS_ROOM_TYPES.includes(t);
  fired.push(t === "kitchen" || t === "kitchenette" ? "interior.kitchen_triangle" : t === "nursery" ? "interior.nursery_safety" : t === "living room" ? "interior.seating_group" : "interior.room_type");
  return {
    fired,
    text: `## Interior design rules\n- ${base}\n- Comfy/ideal spacing 0.6-0.9m between items, wider for wheelchair routes.\n${roomStyle ? `- Room style "${roomStyle}" informs only aesthetic rationale, never overrides architectural/engineering rules.\n` : ""}${egress ? "- Nursery/bedroom: hard safety check enforces egress after placement.\n" : ""}`,
  };
}

// ─────────────────────────────────────────────────────────────
//  DETERMINISTIC PLACEMENT (no LLM)
// ─────────────────────────────────────────────────────────────
function makePlacer(w, h, seed) {
  const placed = [];
  const rng = mulberry32(seed);
  const over = (x, y, iw, ih) =>
    placed.some((p) => rectangularsOverlap({ x, y, w: iw, h: ih }, p));

  // scan a grid around a preferred target for a clear spot
  function findClear(prefX, prefY, iw, ih, pad = 0) {
    const step = 0.1;
    const limit = Math.ceil(Math.max(w, h) / step);
    let best = null, bestD = Infinity;
    for (let r = 0; r <= limit; r++) {
      const pend = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        pend.push([prefX + dx * step, prefY + dy * step]);
      }
      pend.sort((a, b) =>
        (a[0] - prefX) ** 2 + (a[1] - prefY) ** 2 - ((b[0] - prefX) ** 2 + (b[1] - prefY) ** 2)
      );
      for (const [cx, cy] of pend) {
        const x = Math.min(Math.max(0, cx), Math.max(0, w - iw));
        const y = Math.min(Math.max(0, cy), Math.max(0, h - ih));
        if (over(x, y, iw, ih)) continue;
        const d = (x - prefX) ** 2 + (y - prefY) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
          if (bestD === 0) return best;
        }
      }
    }
    // fallback: place at preferred clamped even if overlapping (rare)
    return best || { x: Math.min(Math.max(0, prefX), Math.max(0, w - iw)), y: Math.min(Math.max(0, prefY), Math.max(0, h - ih)) };
  }

  // shorthand: clamp a rect then push it into the placed list
  function push(x, y, iw, ih) {
    const clampedX = Math.min(Math.max(0, x), Math.max(0, w - iw));
    const clampedY = Math.min(Math.max(0, y), Math.max(0, h - ih));
    placed.push({ x: clampedX, y: clampedY, w: iw, h: ih });
    return { x: clampedX, y: clampedY };
  }

  // place an item at a preferred rect; returns rect placed
  function place(prefX, prefY, iw, ih, pad = 0) {
    const spot = findClear(prefX, prefY, iw, ih, pad);
    const placedRect = { x: spot.x, y: spot.y, w: iw, h: ih };
    placed.push(placedRect);
    return placedRect;
  }

  return { placed, rng, findClear, push, place };
}

function planBedroom(furniture, w, h, P) {
  const beds = furniture.filter((f) => BED_IDS.includes(f.furnitureId));
  const nightstands = furniture.filter((f) => f.furnitureId === "nightstand");
  const rest = furniture.filter((f) => !BED_IDS.includes(f.furnitureId) && f.furnitureId !== "nightstand");
  beds.forEach((b) => {
    const [bw, bh] = sizeFor(b.furnitureId);
    let x = (w - bw) / 2, y = 0; // anchored on the top wall
    const rect = P.place(x, y, bw, bh);
    // nightstands flanking the bed
    if (nightstands.length) {
      const [nw, nh] = sizeFor("nightstand");
      const left = nightstands.shift();
      P.place(rect.x - nw - 0.1, rect.y, nw, nh); // left
      if (nightstands.length) {
        const right = nightstands.shift();
        const r = P.place(rect.x + rect.w + 0.1, rect.y, nw, nh); // right
        if (b.furnitureId !== "bed_s") {
          // mirror right nightstand around bed center
          const bc = { cx: rect.x + rect.w / 2 };
          r.x = 2 * bc.cx - (rect.x - nw - 0.1) - nw;
          r.x = Math.min(Math.max(0, r.x), Math.max(0, w - nw));
        }
      }
    }
  });
  // wardrobes against the bottom wall
  rest.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    if (ROLES[f.furnitureId] === "wardrobe" || ROLES[f.furnitureId] === "wall_cab") {
      let x = P.rng() * Math.max(0, w - iw), y = h - ih;
      P.place(x, y, iw, ih);
    } else if (ROLES[f.furnitureId] === "chair" || ROLES[f.furnitureId] === "plant" || ROLES[f.furnitureId] === "tv") {
      P.place(P.rng() * Math.max(0, w - iw), h - ih, iw, ih);
    } else {
      P.place((w - iw) / 2, (h - ih) / 2, iw, ih);
    }
  });
}

function planLivingRoom(furniture, w, h, P) {
  const sofas = furniture.filter((f) => f.furnitureId === "sofa_2" || f.furnitureId === "sofa_3");
  const tv = furniture.find((f) => f.furnitureId === "tv");
  const coffee = furniture.find((f) => f.furnitureId === "coffee");
  const rug = furniture.find((f) => f.furnitureId === "rug");
  const seats = furniture.filter((f) => f.furnitureId === "armchair" || f.furnitureId === "chair");
  const shelves = furniture.filter((f) => ROLES[f.furnitureId] === "wall_cab");
  const plants = furniture.filter((f) => f.furnitureId === "plant");
  const side = furniture.filter((f) => !["sofa_2", "sofa_3", "tv", "coffee", "rug", "armchair", "chair", "plant"].includes(f.furnitureId) && ROLES[f.furnitureId] !== "wall_cab");

  let sofaRect = null;
  sofas.forEach((sf, i) => {
    const [sw, sh] = sizeFor(sf.furnitureId);
    const x = i === 0 ? (w - sw) / 2 : Math.min(Math.max(0, sofaRect.x + sofaRect.w + 0.3), Math.max(0, w - sw));
    const y = h - sh; // bottom wall facing the room center / tv on top wall
    sofaRect = P.place(x, y, sw, sh);
  });
  let tvRect = null;
  if (tv) {
    const [tw, th] = sizeFor("tv");
    tvRect = P.place((w - tw) / 2, 0, tw, th); // top wall = focal wall
  }
  if (coffee && sofaRect) {
    const [cw, ch] = sizeFor("coffee");
    // 0.4m in front of the sofa (toward the TV at the top)
    P.place(sofaRect.x + (sofaRect.w - cw) / 2, sofaRect.y - ch - 0.4, cw, ch);
  }
  if (rug && sofaRect) {
    const [rw, rh] = sizeFor("rug");
    P.place((w - rw) / 2, sofaRect.y - rh - 0.4, rw, rh);
  }
  seats.forEach((s, i) => {
    const [sw, sh] = sizeFor(s.furnitureId);
    if (sofaRect) {
      if (i % 2 === 0) P.place(sofaRect.x - sw - 0.3, sofaRect.y, sw, sh);
      else P.place(sofaRect.x + sofaRect.w + 0.3, sofaRect.y, sw, sh);
    } else {
      P.place((w - sw) / 2, (h - sh) / 2, sw, sh);
    }
  });
  shelves.forEach((shf, i) => {
    const [sw, sh] = sizeFor(shf.furnitureId);
    if (i % 2 === 0) P.place(0, P.rng() * Math.max(0, h - sh), sw, sh);
    else P.place(w - sw, P.rng() * Math.max(0, h - sh), sw, sh);
  });
  plants.forEach((pl, i) => {
    const [pw, ph] = sizeFor("plant");
    if (i % 2 === 0) P.place(0, 0, pw, ph);
    else P.place(w - pw, h - ph, pw, ph);
  });
  side.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    P.place((w - iw) / 2, (h - ih) / 2, iw, ih);
  });
}

function planDiningRoom(furniture, w, h, P) {
  const table = furniture.find((f) => f.furnitureId === "table_rect" || f.furnitureId === "table_round");
  const chairs = furniture.filter((f) => f.furnitureId === "chair");
  const sides = furniture.filter((f) => ROLES[f.furnitureId] === "wall_cab" || ROLES[f.furnitureId] === "wardrobe" || f.furnitureId === "plant");
  let tr = null;
  if (table) {
    const [tw, th] = sizeFor(table.furnitureId);
    tr = P.place((w - tw) / 2, (h - th) / 2, tw, th);
  }
  chairs.forEach((c, i) => {
    const [cw, ch] = sizeFor("chair");
    if (!tr) { P.place((w - cw) / 2, (h - ch) / 2, cw, ch); return; }
    const offsets = [
      [tr.x + (tr.w - cw) / 2, tr.y - ch - 0.15],
      [tr.x + (tr.w - cw) / 2, tr.y + tr.h + 0.15],
      [tr.x - cw - 0.15, tr.y + (tr.h - ch) / 2],
      [tr.x + tr.w + 0.15, tr.y + (tr.h - ch) / 2],
    ];
    P.place(offsets[i % offsets.length][0], offsets[i % offsets.length][1], cw, ch);
  });
  sides.forEach((s) => {
    const [sw, sh] = sizeFor(s.furnitureId);
    const x = s.furnitureId === "plant" ? (s.furnitureId === "plant" && P.rng() > 0.5 ? w - sw : 0) : w - sw;
    P.place(x, h - sh, sw, sh);
  });
}

function planHomeOffice(furniture, w, h, P) {
  const desk = furniture.find((f) => f.furnitureId === "desk");
  const chair = furniture.find((f) => f.furnitureId === "chair");
  const shelves = furniture.filter((f) => ROLES[f.furnitureId] === "wall_cab");
  const rest = furniture.filter((f) => f !== desk && f !== chair && ROLES[f.furnitureId] !== "wall_cab");
  let dr = null;
  if (desk) {
    const [dw, dh] = sizeFor("desk");
    dr = P.place((w - dw) / 2, h - dh, dw, dh); // against bottom wall
  }
  if (chair && dr) {
    const [cw, ch] = sizeFor("chair");
    P.place(dr.x + (dr.w - cw) / 2, dr.y - ch - 0.6, cw, ch); // 0.9m clearance behind chair? place above desk
  } else if (chair) {
    const [cw, ch] = sizeFor("chair");
    P.place((w - cw) / 2, (h - ch) / 2, cw, ch);
  }
  shelves.forEach((sh, i) => {
    const [sw, shh] = sizeFor(sh.furnitureId);
    if (i % 2 === 0) P.place(0, 0, sw, shh);
    else P.place(w - sw, 0, sw, shh);
  });
  rest.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    P.place((w - iw) / 2, (h - ih) / 2, iw, ih);
  });
}

function planKitchen(furniture, w, h, P) {
  const walls = furniture.filter((f) => ["cabinet", "wall_cab", "shelf", "wardrobe"].includes(f.furnitureId));
  const sink = furniture.find((f) => f.furnitureId === "sink");
  const table = furniture.find((f) => f.furnitureId === "table_rect" || f.furnitureId === "table_round");
  const rest = furniture.filter((f) => !["cabinet", "wall_cab", "shelf", "wardrobe", "sink"].includes(f.furnitureId) && f !== table);
  // cabinets flush against walls, spread around the perimeter
  walls.forEach((f, i) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    const sidePos = i % 4;
    let x, y;
    if (sidePos === 0) { x = 0; y = P.rng() * Math.max(0, h - ih); } // left wall
    else if (sidePos === 1) { x = w - iw; y = P.rng() * Math.max(0, h - ih); } // right wall
    else if (sidePos === 2) { x = P.rng() * Math.max(0, w - iw); y = 0; } // top wall
    else { x = P.rng() * Math.max(0, w - iw); y = h - ih; } // bottom wall
    P.place(x, y, iw, ih);
  });
  if (sink) {
    const [sw, sh] = sizeFor("sink");
    P.place((w - sw) / 2, h - sh, sw, sh); // sink on bottom wall, central → within 2m of most
  }
  if (table) {
    const [tw, th] = sizeFor(table.furnitureId);
    P.place((w - tw) / 2, (h - th) / 2, tw, th);
  }
  rest.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    P.place((w - iw) / 2, (h - ih) / 2, iw, ih);
  });
}

function planBathroom(furniture, w, h, P) {
  const wet = furniture.filter((f) => f.furnitureId === "sink" || f.furnitureId === "toilet" || f.furnitureId === "bathtub");
  const rest = furniture.filter((f) => !["sink", "toilet", "bathtub"].includes(f.furnitureId));
  // cluster wet items within 2m: bottom-left corner cluster
  wet.forEach((f, i) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    if (i === 0) P.place(0, h - ih, iw, ih);
    else if (i === 1) P.place(0.1 + iw + 0.2, h - ih, iw, ih);
    else P.place(0.1 + iw + 0.2, Math.max(0, h - ih - ih - 0.2), iw, ih);
  });
  rest.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    P.place(w - iw, 0, iw, ih);
  });
}

function planGeneric(furniture, w, h, P, walkway) {
  // put things along the perimeter in a stable order, leaving the center clear
  const wallWidth = Math.max(0, w - 2 * walkway);
  const wallHeight = Math.max(0, h - 2 * walkway);
  furniture.forEach((f, i) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    const sidePos = i % 4;
    let x, y;
    if (sidePos === 0) x = 0, y = P.rng() * Math.max(0, wallHeight); // left wall
    else if (sidePos === 1) x = w - iw, y = P.rng() * Math.max(0, wallHeight);
    else if (sidePos === 2) x = P.rng() * Math.max(0, wallWidth), y = 0;
    else x = P.rng() * Math.max(0, wallWidth), y = h - ih;
    P.place(x, y, iw, ih);
  });
}

function planStudio(furniture, w, h, P) {
  // zones: sleep against left wall band, work near window (top), lounge center-front (bottom)
  const beds = furniture.filter((f) => BED_IDS.includes(f.furnitureId));
  const desklike = furniture.filter((f) => f.furnitureId === "desk" || f.furnitureId === "shelf" || f.furnitureId === "tv");
  const lounge = furniture.filter((f) => f.furnitureId === "sofa_2" || f.furnitureId === "sofa_3" || f.furnitureId === "coffee" || f.furnitureId === "rug" || f.furnitureId === "armchair" || f.furnitureId === "chair");
  const rest = furniture.filter((f) => !beds.includes(f) && !desklike.includes(f) && !lounge.includes(f));
  beds.forEach((b) => {
    const [bw, bh] = sizeFor(b.furnitureId);
    P.place(0.2, (h - bh) / 2, bw, bh); // sleep zone along left wall
  });
  desklike.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    if (f.furnitureId === "desk") P.place((w - iw) / 2, 0.2, iw, ih); // work zone near top
    else P.place(w - iw - 0.2, 0.2, iw, ih);
  });
  lounge.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    P.place((w - iw) / 2, h - ih - 0.2, iw, ih);
  });
  rest.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    P.place((w - iw) / 2, (h - ih) / 2, iw, ih);
  });
}

function planBedroomAlt(furniture, w, h, P) {
  const beds = furniture.filter((f) => BED_IDS.includes(f.furnitureId));
  const rest = furniture.filter((f) => !BED_IDS.includes(f.furnitureId));
  beds.forEach((b) => {
    const [bw, bh] = sizeFor(b.furnitureId);
    P.place((w - bw) / 2, 0, bw, bh);
  });
  rest.forEach((f) => {
    const [iw, ih] = sizeFor(f.furnitureId);
    P.place((w - iw) / 2, h - ih, iw, ih);
  });
}

function buildNotes(state) {
  const notes = [];
  if (!state.roomWidth || !state.roomLength) notes.push("Room dimensions missing; assumed 4m x 4m.");
  if (!state.doors.length) notes.push("No doors provided; door swing arcs enforced against a default 0.9m radius.");
  if (!state.windows.length) notes.push("No windows provided; egress checks skipped for lack of window data.");
  notes.push("ASSUMPTION: electrical outlet locations are unknown — kitchen outlet proximity measured to nearest wall face (60cm).");
  notes.push("ASSUMPTION: wall geometry is not submitted by the client; wall-alignment snaps to the room boundary edges only.");
  notes.push("Layout generated deterministically (no AI); verify manually before use.");
  return notes;
}

function generateLayout(body) {
  const roomType = body.roomType;
  const w = Number(body.roomWidth) || 4;
  const h = Number(body.roomLength) || 4;
  const t = key(roomType);
  const furniture = (body.furniture || []).map((f) => ({ furnitureId: String(f.furnitureId || "").toLowerCase(), label: f.label || f.furnitureId })).filter((f) => SIZES[f.furnitureId]);
  const { doors, windows } = structuralItems(furniture);

  const P = makePlacer(w, h, 42);

  // layer 1-2-3 rule text (kept for notes/reporting)
  const arch = architecturalRuleText(roomType, doors, windows, w, h);
  const eng = engineeringRuleText(roomType);
  const interior = interiorRuleText(roomType, body.roomStyle);

  const layout = [];
  const rulesApplied = [...arch.fired, ...eng.fired, ...interior.fired];

  // choose a planner per room type
  let planner = planGeneric;
  let walkway = WALKWAY_BY_TYPE[t] || DEFAULT_WALKWAY;
  if (t === "bedroom") planner = planBedroom;
  else if (t === "living room") planner = planLivingRoom;
  else if (t === "dining room") planner = planDiningRoom;
  else if (t === "home office") planner = planHomeOffice;
  else if (t === "kitchen" || t === "kitchenette") planner = planKitchen;
  else if (t === "bathroom" || t === "bath") planner = planBathroom;
  else if (t === "studio apartment") planner = planStudio;

  if (t === "wheelchair friendly" || t === "elderly friendly") {
    planGeneric(furniture, w, h, P, walkway);
  } else {
    planner(furniture, w, h, P);
  }

  // build layout items from placed rects (P.placed is in placement order)
  const byId = {};
  furniture.forEach((f, i) => {
    const p = P.placed[i];
    if (!p) return;
    const item = {
      furnitureId: f.furnitureId,
      x: Math.round(p.x * 1000) / 1000,
      y: Math.round(p.y * 1000) / 1000,
      rotation: 0,
    };
    layout.push(item);
    byId[f.furnitureId] = item;
  });

  // auto-detect nightstand pairs (common) + any explicit pairs from request
  const pairs = [];
  if (body.pairs && Array.isArray(body.pairs)) pairs.push(...body.pairs);
  const ns = layout.filter((i) => i.furnitureId === "nightstand");
  if (ns.length >= 2 && t === "bedroom") {
    const bed = layout.find((i) => BED_IDS.includes(i.furnitureId));
    const anchorId = bed ? bed.furnitureId : "bed_d";
    // tie the two nightstands into a mirror pair around the bed
    const [lt, rt] = ns.slice(0, 2);
    pairs.push({ leftId: lt.furnitureId, rightId: rt.furnitureId, anchorId, axis: "x" });
  }
  if (pairs.length) {
    const n = mirrorPairs(layout, pairs);
    if (n > 0) rulesApplied.push(`alignment.mirror_pairs_${n}`);
  }

  // post-processing: snap grid → re-clamp → wall align
  let snapped = 0, aligned = 0;
  layout.forEach((it) => {
    const [gx, gy] = snapToGrid(it.x, it.y);
    it.x = gx; it.y = gy;
    snapped++;
  });
  rulesApplied.push("alignment.grid_snap");
  layout.forEach((it) => {
    if (alignToWall(it, w, h)) aligned++;
  });
  if (aligned > 0) rulesApplied.push("alignment.wall_snap");
  layout.forEach((it) => clampToRoom(it, w, h));

  const notes = buildNotes({ roomWidth: body.roomWidth, roomLength: body.roomLength, doors, windows });
  const state = {
    layout,
    notes,
    rulesApplied: [...new Set(rulesApplied)],
    disclaimer: DISCLAIMER,
    windows,
  };
  return state;
}

// ─────────────────────────────────────────────────────────────
//  HARD SAFETY CHECKS → 422
// ─────────────────────────────────────────────────────────────
function windowEgressZones(windows, w, h, depth = 1.2, side = 0.3) {
  const zones = [];
  (windows || []).forEach((win) => {
    const [defW, defH] = sizeFor("window");
    const ww = win.width && win.width > 0 ? win.width : defW;
    const wh = win.height && win.height > 0 ? win.height : defH;
    const cx = win.x + ww / 2;
    const cy = win.y + wh / 2;
    const zonesOfEdge = [
      { x0: cx - ww / 2 - side, x1: cx + ww / 2 + side, y0: 0, y1: depth },
      { x0: cx - ww / 2 - side, x1: cx + ww / 2 + side, y0: h - depth, y1: h },
      { x0: 0, x1: depth, y0: cy - wh / 2 - side, y1: cy + wh / 2 + side },
      { x0: w - depth, x1: w, y0: cy - wh / 2 - side, y1: cy + wh / 2 + side },
    ];
    const ds = [cy, h - cy, cx, w - cx];
    let bi = 0;
    ds.forEach((d, i) => { if (d < ds[bi]) bi = i; });
    const z = zonesOfEdge[bi];
    zones.push({
      x0: Math.min(Math.max(0, z.x0), w), x1: Math.min(Math.max(0, z.x1), w),
      y0: Math.min(Math.max(0, z.y0), h), y1: Math.min(Math.max(0, z.y1), h),
    });
  });
  return zones;
}

function checkEgress(layout, windows, w, h, roomType) {
  if (!EGRESS_ROOM_TYPES.includes(key(roomType))) return null;
  if (!windows || !windows.length) return null;
  const zones = windowEgressZones(windows, w, h);
  for (const item of layout) {
    if (heightFor(item.furnitureId) <= DEFAULT_SILL_HEIGHT) continue;
    const [iw, ih] = sizeFor(item.furnitureId);
    for (const z of zones) {
      if (
        item.x < z.x1 && item.x + iw > z.x0 &&
        item.y < z.y1 && item.y + ih > z.y0
      ) {
        return {
          code: "architectural.egress",
          message: `${item.furnitureId} blocks a required egress clearance zone in front of a window (this room type requires egress).`,
          item,
          zone: z,
        };
      }
    }
  }
  return null;
}

function checkNurseryCrib(layout, windows, roomType) {
  if (key(roomType) !== "nursery") return null;
  if (!windows || !windows.length) return null;
  const cribs = layout.filter((i) => BED_IDS.includes(i.furnitureId));
  for (const crib of cribs) {
    const [iw, ih] = sizeFor(crib.furnitureId);
    for (const win of windows) {
      const [defW, defH] = sizeFor("window");
      const ww = win.width && win.width > 0 ? win.width : defW;
      const wh = win.height && win.height > 0 ? win.height : defH;
      const wx0 = win.x - 0.9, wx1 = win.x + ww + 0.9;
      const wy0 = win.y - 0.9, wy1 = win.y + wh + 0.9;
      if (crib.x < wx1 && crib.x + iw > wx0 && crib.y < wy1 && crib.y + ih > wy0) {
        return {
          code: "interior.nursery_windowsill",
          message: `Nursery safety violation: crib (${crib.furnitureId}) is within 0.9m of a window. Move it away from the window.`,
          item: crib,
        };
      }
    }
  }
  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = JSON.parse(req.body || "{}");
  } catch (err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const { roomType, roomWidth, roomLength, furniture = [] } = body;
  if (!roomType) {
    res.status(400).json({ error: "roomType is required" });
    return;
  }
  if (!Array.isArray(furniture) || furniture.length === 0) {
    res.status(400).json({ error: "furniture must be a non-empty array" });
    return;
  }

  const state = generateLayout(body);

  // ── hard safety validation (never delegated) ──
  const { windows } = structuralItems(furniture);
  const w = Number(roomWidth) || 4;
  const h = Number(roomLength) || 4;

  const egress = checkEgress(state.layout, windows, w, h, roomType);
  if (egress) {
    res.status(422).json({ error: egress.message, code: egress.code, layout: state.layout, rulesApplied: state.rulesApplied, disclaimer: DISCLAIMER });
    return;
  }
  const nursery = checkNurseryCrib(state.layout, windows, roomType);
  if (nursery) {
    res.status(422).json({ error: nursery.message, code: nursery.code, layout: state.layout, rulesApplied: state.rulesApplied, disclaimer: DISCLAIMER });
    return;
  }

  res.status(200).json({
    layout: state.layout,
    suggestions: state.layout,
    notes: state.notes,
    rulesApplied: state.rulesApplied,
    disclaimer: state.disclaimer,
  });
}