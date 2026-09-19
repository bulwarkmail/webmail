/**
 * Ready-made account avatars.
 *
 * A new account used to get initials over a colour hashed from its address,
 * which collides cheerfully: two of eight accounts can land on the same hue and
 * become indistinguishable wherever rows are tinted by account. The catalogue
 * below pairs ten shapes with twelve colours, and picking avoids whatever is
 * already on screen, so accounts stay apart by shape as well as by colour -
 * legible in greyscale, and at the 32px the rail draws them.
 *
 * Images are rendered on a canvas to the same 128px WebP data URI the avatar
 * upload produces, because that is the only shape the archive accepts back.
 */

/** The colours `accountTintKey` maps to a dedicated row tint, in order. */
export const ACCOUNT_AVATAR_COLORS = [
  '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706',
  '#65a30d', '#16a34a', '#0d9488', '#0891b2', '#6366f1', '#9333ea',
] as const;

export const ACCOUNT_AVATAR_MOTIFS = [
  'ring', 'bars', 'triangle', 'diagonal', 'diamond',
  'cross', 'dots', 'chevron', 'arch', 'frame',
] as const;

export type AvatarMotif = typeof ACCOUNT_AVATAR_MOTIFS[number];
export interface AccountAvatarDesign {
  motif: AvatarMotif;
  color: string;
}

export const ACCOUNT_AVATAR_COUNT = 50;

/**
 * Ten shapes and twelve colours repeat together only every sixty steps, so the
 * first fifty pairs are distinct, and consecutive ones differ in both.
 */
export const ACCOUNT_AVATAR_DESIGNS: readonly AccountAvatarDesign[] =
  Array.from({ length: ACCOUNT_AVATAR_COUNT }, (_, i) => ({
    motif: ACCOUNT_AVATAR_MOTIFS[i % ACCOUNT_AVATAR_MOTIFS.length]!,
    color: ACCOUNT_AVATAR_COLORS[i % ACCOUNT_AVATAR_COLORS.length]!,
  }));

const SIZE = 128;

function paint(context: CanvasRenderingContext2D, motif: AvatarMotif, color: string): void {
  const s = SIZE;
  context.fillStyle = color;
  context.fillRect(0, 0, s, s);
  context.fillStyle = '#ffffff';
  const path = new Path2D();
  switch (motif) {
    case 'ring':
      // Each arc opens its own subpath: without the moveTo the path would draw
      // a connecting line from wherever the previous one ended.
      path.moveTo(102, 64); path.arc(64, 64, 38, 0, Math.PI * 2);
      path.moveTo(80, 64); path.arc(64, 64, 16, 0, Math.PI * 2);
      break;
    case 'bars':
      for (const y of [30, 58, 86]) path.roundRect(26, y, 76, 16, 8);
      break;
    case 'triangle':
      path.moveTo(64, 24); path.lineTo(108, 102); path.lineTo(20, 102);
      break;
    case 'diagonal':
      path.moveTo(0, 96); path.lineTo(96, 0); path.lineTo(128, 32); path.lineTo(32, 128);
      break;
    case 'diamond':
      path.moveTo(64, 18); path.lineTo(110, 64); path.lineTo(64, 110); path.lineTo(18, 64);
      break;
    case 'cross':
      path.roundRect(54, 22, 20, 84, 8);
      path.roundRect(22, 54, 84, 20, 8);
      break;
    case 'dots':
      for (const cx of [40, 88]) for (const cy of [40, 88]) {
        path.moveTo(cx + 16, cy);
        path.arc(cx, cy, 16, 0, Math.PI * 2);
      }
      break;
    case 'chevron':
      for (const off of [0, 34]) {
        path.moveTo(28, 26 + off); path.lineTo(64, 56 + off); path.lineTo(100, 26 + off);
        path.lineTo(100, 44 + off); path.lineTo(64, 74 + off); path.lineTo(28, 44 + off);
      }
      break;
    case 'arch':
      path.moveTo(22, 74); path.arc(64, 74, 42, Math.PI, 0); path.closePath();
      path.moveTo(44, 74); path.arc(64, 74, 20, Math.PI, 0); path.closePath();
      break;
    case 'frame':
      path.rect(22, 22, 84, 84);
      path.rect(46, 46, 36, 36);
      break;
  }
  context.fill(path, 'evenodd');
}

/**
 * Render a design, or nothing where there is no canvas - server rendering and
 * the test environment both land here, and an account without a picture simply
 * falls back to its initials.
 */
export function renderAccountAvatar(design: AccountAvatarDesign): string | undefined {
  try {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    paint(context, design.motif, design.color);
    const uri = canvas.toDataURL('image/webp', 0.85);
    // A canvas stub that cannot encode WebP hands back a png or a bare string.
    return /^data:image\/(webp|png|jpeg|gif);base64,/.test(uri) ? uri : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Choose a design for a new account, preferring colours no account is using.
 * Beyond twelve accounts the colours are spoken for and the shape carries the
 * distinction on its own.
 */
export function pickAccountAvatar(
  usedColors: readonly string[] = [],
  random: () => number = Math.random,
): AccountAvatarDesign {
  const taken = new Set(usedColors.map(c => c.toLowerCase()));
  const free = ACCOUNT_AVATAR_DESIGNS.filter(d => !taken.has(d.color.toLowerCase()));
  const pool = free.length ? free : ACCOUNT_AVATAR_DESIGNS;
  return pool[Math.floor(random() * pool.length) % pool.length]!;
}
