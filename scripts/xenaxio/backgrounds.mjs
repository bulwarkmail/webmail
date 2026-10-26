#!/usr/bin/env node
// xenaxio step 41: draws the background pictures of the web client
// (public/xenaxio/backgrounds). Our own artwork, so no third-party licence:
// abstract landscapes made of SVG shapes, rendered and compressed by sharp.
// Deterministic (seeded), so a re-run gives the same files.
//
//   node scripts/xenaxio/backgrounds.mjs
//
// Every picture has a light and a dark variant, a small preview and a
// blurred copy for the frosted navigation.
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../public/xenaxio/backgrounds");
const W = 2560;
const H = 1440;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A ridge line by midpoint displacement: `n` levels, `rough` = how much each level shrinks. */
function ridge(rand, base, amp, rough = 0.55, levels = 9) {
  let pts = [base + (rand() - 0.5) * amp, base + (rand() - 0.5) * amp];
  let a = amp;
  for (let l = 0; l < levels; l++) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push(pts[i], (pts[i] + pts[i + 1]) / 2 + (rand() - 0.5) * a);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    a *= rough;
  }
  const step = W / (pts.length - 1);
  return pts.map((y, i) => [i * step, y]);
}

/** A smooth line from a sum of sines. */
function waves(rand, base, parts, from = 0, to = W) {
  const ph = parts.map(() => rand() * Math.PI * 2);
  const pts = [];
  for (let x = from; x <= to; x += 16) {
    let y = base;
    parts.forEach(([amp, len], i) => (y += amp * Math.sin((x / len) * Math.PI * 2 + ph[i])));
    pts.push([x, y]);
  }
  return pts;
}

const area = (pts) => `M0,${H} L${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L")} L${W},${H} Z`;

const mix = (a, b, t) => {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
};

/** `pad`: drawn this much larger on every side (cut off later), so blurs near the edge stay full. */
function svg(defs, body, pad = 0) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 2 * pad}" height="${H + 2 * pad}" viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}"><defs>${defs}</defs>${body}</svg>`;
}
const AURORA_PAD = 240;

const sky = (id, stops) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;

const glow = (id, color, opacity = 1) =>
  `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;

// The filter covers the whole picture, so a wide blur is never cut off at the shape's box.
const blur = (id, d) =>
  `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-W / 4}" y="${-H / 4}" width="${W * 1.5}" height="${H * 1.5}"><feGaussianBlur stdDeviation="${d}"/></filter>`;

// --- Scenes -----------------------------------------------------------------------

/** Layered mountain ridges in haze. */
function mountains(p) {
  const rand = rng(11);
  const layers = 6;
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/><ellipse cx="${W * 0.68}" cy="${H * 0.36}" rx="${W * 0.32}" ry="${H * 0.3}" fill="url(#sun)"/>`;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const pts = ridge(rand, H * (0.42 + t * 0.4), H * (0.36 - t * 0.2), 0.52 + t * 0.06);
    body += `<path d="${area(pts)}" fill="${mix(p.far, p.near, t)}"/>`;
    if (i < layers - 1) body += `<rect y="${H * (0.4 + t * 0.4)}" width="${W}" height="${H * 0.25}" fill="url(#fog)"/>`;
  }
  return svg(sky("sky", p.sky) + glow("sun", p.sun, 0.75) + sky("fog", [[0, p.fog + "00"], [0.5, p.fog + "55"], [1, p.fog + "00"]]), body);
}

/** Soft dunes under a low sun. */
function dunes(p) {
  const rand = rng(23);
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/><ellipse cx="${W * 0.3}" cy="${H * 0.42}" rx="${W * 0.28}" ry="${H * 0.26}" fill="url(#sun)"/>`;
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const pts = waves(rand, H * (0.5 + t * 0.32), [[H * 0.05, W * 1.3], [H * 0.03, W * 0.55], [H * 0.008, W * 0.17]]);
    body += `<path d="${area(pts)}" fill="url(#d${i})"/>`;
  }
  let defs = sky("sky", p.sky) + glow("sun", p.sun, 0.85);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const c = mix(p.far, p.near, t);
    defs += `<linearGradient id="d${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mix(c, p.light, 0.35)}"/><stop offset="0.55" stop-color="${c}"/><stop offset="1" stop-color="${mix(c, p.shade, 0.45)}"/></linearGradient>`;
  }
  return svg(defs, body);
}

/** Open sea with a glowing horizon. */
function sea(p) {
  const rand = rng(37);
  const horizon = H * 0.56;
  let body = `<rect width="${W}" height="${horizon + 2}" fill="url(#sky)"/><rect y="${horizon}" width="${W}" height="${H - horizon}" fill="url(#water)"/>`;
  body += `<ellipse cx="${W * 0.55}" cy="${horizon}" rx="${W * 0.36}" ry="${H * 0.22}" fill="url(#sun)"/>`;
  // Clouds: blurred bands.
  for (let i = 0; i < 7; i++) {
    const y = H * (0.12 + rand() * 0.34);
    body += `<ellipse cx="${rand() * W}" cy="${y}" rx="${W * (0.12 + rand() * 0.2)}" ry="${H * (0.015 + rand() * 0.03)}" fill="${p.cloud}" opacity="${0.25 + rand() * 0.35}" filter="url(#soft)"/>`;
  }
  // Glitter on the water: short lines, denser near the sun's reflection.
  for (let i = 0; i < 260; i++) {
    const depth = rand() ** 1.6;
    const y = horizon + 6 + depth * (H - horizon);
    const spread = W * (0.05 + depth * 0.35);
    const x = W * 0.55 + (rand() - 0.5) * 2 * spread;
    const len = 10 + depth * 90 * rand();
    body += `<rect x="${x}" y="${y}" width="${len}" height="${1.5 + depth * 3}" rx="2" fill="${p.glint}" opacity="${(0.15 + rand() * 0.5) * (1 - depth * 0.6)}"/>`;
  }
  return svg(sky("sky", p.sky) + sky("water", p.water) + glow("sun", p.sun, 0.8) + blur("soft", 18), body);
}

/** Ribbons of light in the sky above a dark ridge. */
function aurora(p) {
  const rand = rng(41);
  const pad = AURORA_PAD;
  let body = `<rect x="${-pad}" y="${-pad}" width="${W + 2 * pad}" height="${H + 2 * pad}" fill="url(#sky)"/>`;
  for (let i = 0; i < 90; i++) {
    body += `<circle cx="${rand() * W}" cy="${rand() * H * 0.6}" r="${0.8 + rand() * 1.6}" fill="${p.star}" opacity="${0.2 + rand() * 0.6}"/>`;
  }
  const colors = p.ribbons;
  for (let i = 0; i < 4; i++) {
    // Longer than the picture, so the blurred ends lie outside it.
    const pts = waves(rand, H * (0.22 + i * 0.07), [[H * 0.1, W * 1.1], [H * 0.05, W * 0.45]], -W * 0.15, W * 1.15);
    const d = `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L")}`;
    body += `<path d="${d}" stroke="${colors[i % colors.length]}" stroke-width="${H * (0.08 + rand() * 0.08)}" fill="none" opacity="${0.55 + rand() * 0.3}" filter="url(#glow)"/>`;
  }
  body += `<path d="${area(ridge(rand, H * 0.84, H * 0.12, 0.5))}" fill="${p.ground}"/>`;
  return svg(sky("sky", p.sky) + blur("glow", 60), body, pad);
}

/** Large soft spheres, as in a bokeh. */
function bloom(p) {
  const rand = rng(53);
  let body = `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  for (let i = 0; i < 14; i++) {
    const r = H * (0.06 + rand() ** 2 * 0.3);
    const c = p.balls[i % p.balls.length];
    const id = `b${i}`;
    body += `<defs><radialGradient id="${id}" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="${mix(c, "#ffffff", 0.55)}"/><stop offset="0.45" stop-color="${c}"/><stop offset="1" stop-color="${mix(c, p.shade, 0.5)}"/></radialGradient></defs>`;
    body += `<circle cx="${rand() * W}" cy="${rand() * H}" r="${r}" fill="url(#${id})" opacity="${0.55 + rand() * 0.4}" ${r < H * 0.12 ? 'filter="url(#soft)"' : ""}/>`;
  }
  return svg(sky("bg", p.bg) + blur("soft", 14), body);
}

/** Rolling hills with mist. */
function hills(p) {
  const rand = rng(67);
  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/><ellipse cx="${W * 0.78}" cy="${H * 0.3}" rx="${W * 0.22}" ry="${H * 0.22}" fill="url(#sun)"/>`;
  const n = 6;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const pts = waves(rand, H * (0.45 + t * 0.36), [[H * 0.06, W * 0.9], [H * 0.035, W * 0.38], [H * 0.006, W * 0.08]]);
    body += `<path d="${area(pts)}" fill="${mix(p.far, p.near, t)}"/>`;
    if (i < n - 1) body += `<rect y="${H * (0.42 + t * 0.36)}" width="${W}" height="${H * 0.16}" fill="url(#mist)"/>`;
  }
  return svg(sky("sky", p.sky) + glow("sun", p.sun, 0.7) + sky("mist", [[0, p.mist + "00"], [0.6, p.mist + "66"], [1, p.mist + "00"]]), body);
}

// --- Palettes ---------------------------------------------------------------------

const SCENES = {
  "img-mountains": {
    draw: mountains,
    light: { sky: [[0, "#9ec5e8"], [0.6, "#dbe9f4"], [1, "#f4efe9"]], sun: "#fff4dc", fog: "#eef3f8", far: "#b9cbe0", near: "#3d5a80" },
    dark: { sky: [[0, "#0b1426"], [0.6, "#1d2b4a"], [1, "#3a3550"]], sun: "#6a5a8a", fog: "#2a3654", far: "#2b3a5c", near: "#090f1d" },
  },
  "img-dunes": {
    draw: dunes,
    light: { sky: [[0, "#f6d7b8"], [0.5, "#fbe9d6"], [1, "#fff6ec"]], sun: "#fff3d6", far: "#f0c79a", near: "#c97b4a", light: "#fff1dc", shade: "#8c4a2a" },
    dark: { sky: [[0, "#120c24"], [0.55, "#3a1f3f"], [1, "#6b3442"]], sun: "#ff9a6a", far: "#5a2f45", near: "#1b0f20", light: "#a8576a", shade: "#08040c" },
  },
  "img-sea": {
    draw: sea,
    light: { sky: [[0, "#7fb2e5"], [1, "#e8f1fa"]], water: [[0, "#5d93c9"], [1, "#1f4f86"]], sun: "#ffffff", cloud: "#ffffff", glint: "#ffffff" },
    dark: { sky: [[0, "#060b1c"], [0.7, "#1c2148"], [1, "#4a3a6e"]], water: [[0, "#1b2450"], [1, "#03060f"]], sun: "#8f7bd1", cloud: "#2b2f5c", glint: "#c9c3ff" },
  },
  "img-aurora": {
    draw: aurora,
    pad: AURORA_PAD,
    light: { sky: [[0, "#cde6f2"], [0.7, "#eef6f6"], [1, "#f7f4ee"]], star: "#ffffff", ribbons: ["#7fe0c4", "#9fc7ff", "#d0a8f0", "#8ae3d5"], ground: "#6c8aa0" },
    dark: { sky: [[0, "#020711"], [0.7, "#071a2a"], [1, "#0d2a35"]], star: "#ffffff", ribbons: ["#1fe0a0", "#2aa6ff", "#9b5cff", "#18c7b0"], ground: "#02060c" },
  },
  "img-bloom": {
    draw: bloom,
    light: { bg: [[0, "#f3e8ff"], [1, "#ffe9f2"]], balls: ["#d8a8ff", "#ff9ccf", "#a8c8ff", "#ffc6a8"], shade: "#7a4ab0" },
    dark: { bg: [[0, "#120a24"], [1, "#25082a"]], balls: ["#8a3cff", "#ff3ca0", "#3c7aff", "#c23cff"], shade: "#050208" },
  },
  "img-hills": {
    draw: hills,
    light: { sky: [[0, "#bfe0e8"], [1, "#f6f4e6"]], sun: "#fffbe0", mist: "#f2f6ee", far: "#bcd7c0", near: "#3f7a52" },
    dark: { sky: [[0, "#06130f"], [0.7, "#123026"], [1, "#2a4636"]], sun: "#3f7a5c", mist: "#1e3a30", far: "#21463a", near: "#030b08" },
  },
};

mkdirSync(OUT, { recursive: true });
for (const [id, scene] of Object.entries(SCENES)) {
  for (const mode of ["light", "dark"]) {
    const pad = scene.pad ?? 0;
    const drawn = await sharp(Buffer.from(scene.draw(scene[mode]))).flatten().png().toBuffer();
    const png = pad ? await sharp(drawn).extract({ left: pad, top: pad, width: W, height: H }).png().toBuffer() : drawn;
    const file = join(OUT, `${id}-${mode}.webp`);
    await sharp(png).webp({ quality: 72, effort: 6 }).toFile(file);
    await sharp(png).resize(320, 180).webp({ quality: 70 }).toFile(join(OUT, `${id}-${mode}-thumb.webp`));
    // The frosted copy under the see-through navigation (blurred here, not in the browser).
    await sharp(png).resize(640, 360).blur(14).webp({ quality: 70 }).toFile(join(OUT, `${id}-${mode}-blur.webp`));
    console.log(`${file.slice(OUT.length + 1)} ${(statSync(file).size / 1024).toFixed(0)} KB`);
  }
}
