export default (function () {
  'use strict';

  var PENDING_CLASS = 'bulwark-dark-pending';

  function docPart(doc, name) {
    try {
      var d = Object.getOwnPropertyDescriptor(Document.prototype, name);
      if (d && d.get) return d.get.call(doc);
    } catch (e) {
      return doc[name];
    }
    return doc[name];
  }
  function docCall(doc, name, args) {
    var fn = null;
    try { fn = Document.prototype[name]; } catch (e) { fn = null; }
    if (typeof fn === 'function') {
      try { return fn.apply(doc, args); } catch (e) { return doc[name].apply(doc, args); }
    }
    return doc[name].apply(doc, args);
  }

  var NOT_A_COLOR = /^(?:none|auto|currentcolor|inherit|initial|unset|revert|revert-layer)$/i;

  function parseComputedColor(value) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value || '');
    if (!m) return null;
    var a = 1;
    if (m[4] !== undefined && m[4] !== '') {
      a = m[4].charAt(m[4].length - 1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }

  var probed = new Map();

  function parseColor(value, doc) {
    if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var rgb = parseComputedColor(value);
    if (rgb || !doc || !value || NOT_A_COLOR.test(value)) return rgb;
    if (probed.has(value)) return probed.get(value);
    var out = null;
    try {
      var canvas = docCall(doc, 'createElement', ['canvas']);
      canvas.width = 1;
      canvas.height = 1;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = 'rgba(0, 0, 0, 0)';
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        var d = ctx.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    } catch (e) {
      out = null;
    }
    if (probed.size > 500) probed.clear();
    probed.set(value, out);
    return out;
  }

  function formatColor(c) {
    var R = Math.round(c.r), G = Math.round(c.g), B = Math.round(c.b);
    return c.a >= 1
      ? 'rgb(' + R + ', ' + G + ', ' + B + ')'
      : 'rgba(' + R + ', ' + G + ', ' + B + ', ' + (+c.a.toFixed(3)) + ')';
  }

  function toLinear(v) {
    var c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function fromLinear(v) {
    var c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return c * 255;
  }

  function toLch(c) {
    var lr = toLinear(c.r), lg = toLinear(c.g), lb = toLinear(c.b);
    var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    var L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { l: L, c: Math.sqrt(A * A + B * B), h: Math.atan2(B, A) };
  }

  function lchToLinear(L, C, H) {
    var A = C * Math.cos(H), B = C * Math.sin(H);
    var l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    var m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    var s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];
  }

  function outOfGamut(lin) {
    for (var i = 0; i < 3; i++) if (lin[i] < -1e-4 || lin[i] > 1 + 1e-4) return true;
    return false;
  }

  function fromLch(L, C, H, a) {
    if (L >= 1) return { r: 255, g: 255, b: 255, a: a };
    if (L <= 0) return { r: 0, g: 0, b: 0, a: a };
    var lin = lchToLinear(L, C, H);
    for (var i = 0; i < 30 && outOfGamut(lin); i++) {
      C *= 0.88;
      lin = lchToLinear(L, C, H);
    }
    var ch = lin.map(function (v) { return Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v)))))); });
    return { r: ch[0], g: ch[1], b: ch[2], a: a };
  }

  function luminance(c) {
    return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
  }

  function contrastRatio(x, y) {
    var lx = luminance(x), ly = luminance(y);
    return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
  }

  function apcaContrast(text, bg) {
    var y = function (c) {
      return 0.2126729 * Math.pow(c.r / 255, 2.4) + 0.7151522 * Math.pow(c.g / 255, 2.4) + 0.072175 * Math.pow(c.b / 255, 2.4);
    };
    var clamp = function (v) { return v > 0.022 ? v : v + Math.pow(0.022 - v, 1.414); };
    var t = clamp(y(text)), s = clamp(y(bg));
    var lc = s > t ? (Math.pow(s, 0.56) - Math.pow(t, 0.57)) * 1.14 : (Math.pow(s, 0.65) - Math.pow(t, 0.62)) * 1.14;
    return Math.abs(lc) < 0.1 ? 0 : (Math.abs(lc) - 0.027) * 100;
  }

  function sameColor(x, y) {
    return Math.round(x.r) === Math.round(y.r) && Math.round(x.g) === Math.round(y.g) &&
      Math.round(x.b) === Math.round(y.b) && Math.abs(x.a - y.a) < 0.01;
  }

  function closeTo(x, y) {
    return Math.abs(x.r - y.r) <= 2 && Math.abs(x.g - y.g) <= 2 && Math.abs(x.b - y.b) <= 2;
  }

  function composite(top, under) {
    var a = top.a;
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
  }

  var WHITE = { r: 255, g: 255, b: 255, a: 1 };
  var DEFAULT_CANVAS = { r: 20, g: 20, b: 20, a: 1 };
  var VIVID_CHROMA = 0.09;
  var VIVID_DIM = 0.7;
  var DARK_L = 0.45;
  var TEXT_APCA_MAX = 85;
  var TEXT_APCA = 60;
  var TEXT_MIN = 4.5;
  var FOLD_MIN = 0.25;
  var PICTURE_TAGS = 'img,picture,video,canvas,svg,iframe,object,embed,input';
  function paintsBeyondText(cs) {
    var none = function (v) { return !v || v === 'none'; };
    return shadowPaints(cs.boxShadow) || shadowPaints(cs.textShadow) ||
      ((cs.outlineStyle || 'none') !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
      !none(cs.filter) || !none(cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter')) ||
      (cs.mixBlendMode || 'normal') !== 'normal' || !none(cs.clipPath) || !none(cs.mask || cs.getPropertyValue('-webkit-mask-image')) ||
      !none(cs.borderImageSource || cs.getPropertyValue('border-image-source'));
  }

  function shadowPaints(value) {
    var v = (value || 'none').trim();
    return v !== 'none' && !/^rgba\([^()]*,\s*0\)$/.test(v) && v !== 'transparent';
  }

  function outOfFlow(cs) {
    return (cs.position || 'static') !== 'static' || (cs.cssFloat || cs.getPropertyValue('float') || 'none') !== 'none' ||
      (!!cs.transform && cs.transform !== 'none') ||
      ['top', 'right', 'bottom', 'left'].some(function (side) { return parseFloat(cs.getPropertyValue('margin-' + side)) < 0; });
  }
  var TEXT_CURVE = 0.6;
  var SURFACE_CURVE = [[1, 0], [0.955, 0.065], [0.9, 0.1], [0.8, 0.14], [0.68, 0.17]];

  function surfaceLightness(l, base) {
    for (var i = 1; i < SURFACE_CURVE.length; i++) {
      var p = SURFACE_CURVE[i - 1], q = SURFACE_CURVE[i];
      if (l >= q[0]) return base + p[1] + (q[1] - p[1]) * Math.max(0, p[0] - l) / (p[0] - q[0]);
    }
    var last = SURFACE_CURVE[SURFACE_CURVE.length - 1];
    var top = base + last[1];
    return top + (DARK_L - top) * (last[0] - l) / (last[0] - DARK_L);
  }

  function darkenBackground(color, canvas) {
    if (!color || color.a === 0) return color;
    var lch = toLch(color);
    if (lch.c >= VIVID_CHROMA) {
      var fill = lch.l <= 0.6 ? color : fromLch(Math.max(0.42, lch.l * VIVID_DIM), lch.c, lch.h, color.a);
      if (labelReads(WHITE, fill)) return fill;
      var label = function (candidate) { return labelReads(WHITE, candidate); };
      var dimmed = solveLightness(toLch(fill), label, false);
      return { r: dimmed.r, g: dimmed.g, b: dimmed.b, a: color.a };
    }
    var base = toLch(canvas || DEFAULT_CANVAS);
    var neutral = lch.c < 0.02;
    if (lch.l <= DARK_L) {
      return neutral && base.c >= 0.02 ? fromLch(lch.l, base.c * Math.min(1, lch.l / Math.max(base.l, 0.01)), base.h, color.a) : color;
    }
    return fromLch(
      surfaceLightness(lch.l, base.l),
      neutral ? base.c : Math.max(base.c, lch.c * 0.55),
      neutral ? base.h : lch.h,
      color.a
    );
  }

  function labelReads(text, bg, lc) {
    return contrastRatio(text, bg) >= TEXT_MIN && apcaContrast(text, bg) >= (lc || TEXT_APCA);
  }

  function solveLightness(lch, ok, lighten) {
    var lo = lighten ? lch.l : 0, hi = lighten ? 1 : lch.l;
    var best = fromLch(lighten ? 1 : 0, lch.c, lch.h, 1);
    for (var i = 0; i < 22; i++) {
      var mid = (lo + hi) / 2;
      var candidate = fromLch(mid, lch.c, lch.h, 1);
      var reaches = ok(candidate);
      if (reaches) best = candidate;
      if (reaches === lighten) hi = mid;
      else lo = mid;
    }
    return best;
  }

  function readsBetter(a, b, bg) {
    var wa = contrastRatio(a, bg) >= TEXT_MIN, wb = contrastRatio(b, bg) >= TEXT_MIN;
    if (wa !== wb) return wa ? a : b;
    var score = function (c) { return Math.min(contrastRatio(c, bg) / TEXT_MIN, apcaContrast(c, bg) / TEXT_APCA); };
    return score(b) > score(a) ? b : a;
  }

  function adaptTextColor(color, bg, bgOriginal, keep) {
    if (!color || color.a === 0) return color;
    var k = keep > 0 && keep < 1 ? keep : 1;
    var faded = function (c, a, under) { return composite({ r: c.r, g: c.g, b: c.b, a: a * k }, under); };
    var seen = function (candidate) { return k < 1 ? faded(candidate, 1, bg) : candidate; };
    var sent = contrastRatio(faded(color, color.a, bgOriginal), bgOriginal);
    var share = Math.min(1, Math.max(0, (sent - 3) / 18));
    var target = sent >= 3 ? TEXT_APCA + (TEXT_APCA_MAX - TEXT_APCA) * Math.pow(share, TEXT_CURVE) : TEXT_APCA;
    var now = faded(color, color.a, bg);
    var lch = toLch(now);
    var bgL = toLch(bg).l;
    var lighten = bgL < 0.6;
    var reads = function (candidate) { return labelReads(seen(candidate), bg, target); };
    if ((lighten ? lch.l > bgL : lch.l < bgL) && labelReads(now, bg, target)) return color;
    var hue = { l: bgL, c: lch.c > 0.15 ? lch.c * 0.85 : lch.c, h: lch.h };
    var preferred = solveLightness(hue, reads, lighten);
    if (reads(preferred)) return preferred;
    var other = solveLightness(hue, reads, !lighten);
    var shownPreferred = seen(preferred), shownOther = seen(other);
    var best = readsBetter(shownPreferred, shownOther, bg) === shownOther ? other : preferred;
    return readsBetter(now, best === other ? shownOther : shownPreferred, bg) === now ? color : best;
  }

  function adaptBorderColor(color, parentBg, canvas) {
    if (!color || color.a === 0) return color;
    var next = toLch(color).l > DARK_L ? darkenBackground(color, canvas) : color;
    var opaque = composite(next, parentBg);
    if (contrastRatio(opaque, parentBg) >= 1.25) return next;
    var rule = toLch(opaque);
    var bgL = toLch(parentBg).l;
    return solveLightness({ l: bgL, c: rule.c, h: rule.h }, function (candidate) { return contrastRatio(candidate, parentBg) >= 1.35; }, bgL < 0.6);
  }

  var FRAME_MIN = 1.6;
  var SEPARATION = 1.8;

  function liftApart(color, bg, min) {
    var opaque = composite(color, bg);
    if (contrastRatio(opaque, bg) >= min) return color;
    var own = toLch(opaque);
    var bgL = toLch(bg).l;
    var lighten = bgL < 0.6;
    var start = lighten ? Math.max(own.l, bgL) : Math.min(own.l, bgL);
    var lifted = solveLightness({ l: start, c: own.c, h: own.h }, function (candidate) { return contrastRatio(candidate, bg) >= min; }, lighten);
    return { r: lifted.r, g: lifted.g, b: lifted.b, a: 1 };
  }

  var COLOR_FUNCTION = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/gi;

  function mapGradientColors(value, map, doc) {
    return value.replace(COLOR_FUNCTION, function (m) {
      var c = parseColor(m, doc);
      return c ? formatColor(map(c)) : m;
    });
  }

  function gradientStops(value, doc) {
    if (!value || !/gradient\(/i.test(value) || /url\(/i.test(value)) return [];
    var found = value.match(COLOR_FUNCTION) || [];
    var stops = [];
    for (var i = 0; i < found.length; i++) {
      var c = parseColor(found[i], doc);
      if (c) stops.push(c);
    }
    return stops;
  }

  function averageGradient(value, doc) {
    var stops = gradientStops(value, doc);
    var sum = { r: 0, g: 0, b: 0, a: 0 };
    for (var i = 0; i < stops.length; i++) {
      sum.r += stops[i].r; sum.g += stops[i].g; sum.b += stops[i].b; sum.a += stops[i].a;
    }
    var n = stops.length;
    return n ? { r: sum.r / n, g: sum.g / n, b: sum.b / n, a: sum.a / n } : null;
  }

  function gradientSurface(stops, map, under, underOriginal) {
    var pairs = stops.map(function (stop) {
      return { bg: composite(map(stop), under), original: composite(stop, underOriginal) };
    });
    var mean = 0;
    pairs.forEach(function (p) { mean += toLch(p.bg).l / pairs.length; });
    var worst = pairs[0];
    pairs.forEach(function (p) {
      var lp = luminance(p.bg), lw = luminance(worst.bg);
      if (mean < 0.6 ? lp > lw : lp < lw) worst = p;
    });
    return { bg: worst.bg, original: worst.original, onImage: false, clear: false };
  }

  function readSurfaceColor(el, fallback) {
    var doc = el.ownerDocument;
    var win = docPart(doc, 'defaultView');
    var layers = [];
    var under = fallback || WHITE;
    outer: for (var n = el; n && win; n = n.parentElement) {
      var cs = win.getComputedStyle(n);
      var own = [averageGradient(cs.backgroundImage, doc), parseColor(cs.backgroundColor, doc)];
      for (var i = 0; i < own.length; i++) {
        if (!own[i] || own[i].a === 0) continue;
        if (own[i].a >= 1) { under = own[i]; break outer; }
        layers.push(own[i]);
      }
    }
    for (var j = layers.length - 1; j >= 0; j--) under = composite(layers[j], under);
    return { r: under.r, g: under.g, b: under.b, a: 1 };
  }

  function judgeImagePixels(data, bg) {
    var clear = 0, drawn = 0, hidden = 0, white = 0, dark = 0, colourful = 0;
    for (var i = 0; i < data.length; i += 4) {
      var a = data[i + 3] / 255;
      if (a < 0.5) { clear++; continue; }
      drawn++;
      var R = data[i], G = data[i + 1], B = data[i + 2];
      if (contrastRatio(composite({ r: R, g: G, b: B, a: a }, bg), bg) < 2) hidden++;
      var Y = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
      var spread = Math.max(R, G, B) - Math.min(R, G, B);
      if (spread > 30) colourful++;
      if (Y > 0.92 && spread < 12) white++;
      else if (Y < 0.3) dark++;
    }
    if (drawn === 0) return 'fine';
    if (clear / (data.length / 4) >= 0.02) return hidden / drawn > 0.15 ? 'flip' : 'fine';
    var ink = drawn - white;
    var flat = (white + dark) / drawn > 0.85 && (ink ? (ink - dark) / ink : 0) < 0.3;
    return flat && white / drawn > 0.1 && colourful / drawn < 0.05 ? 'flip' : 'fine';
  }

  function flipFilterMatrix(canvas) {
    var Y = [0.2126, 0.7152, 0.0722];
    function row(k, own) {
      var f = 2 - k;
      return [(own === 0 ? 1 : 0) - f * Y[0], (own === 1 ? 1 : 0) - f * Y[1], (own === 2 ? 1 : 0) - f * Y[2], 0, 1];
    }
    return row(canvas.r / 255, 0).concat(row(canvas.g / 255, 1), row(canvas.b / 255, 2), [0, 0, 0, 1, 0]);
  }

  var flipFilters = new WeakMap();

  function flipFilterId(doc, bg) {
    var body = docPart(doc, 'body');
    if (!body) return null;
    var known = flipFilters.get(doc);
    if (!known) {
      known = { prefix: 'bulwark-dark-flip-' + Math.random().toString(36).slice(2, 10) + '-', ids: {}, count: 0 };
      flipFilters.set(doc, known);
    }
    var key = formatColor(bg);
    if (known.ids[key]) return known.ids[key];
    var id = known.prefix + known.count++;
    var values = flipFilterMatrix(bg).map(function (v) { return +v.toFixed(5); }).join(' ');
    var holder = docCall(doc, 'createElement', ['div']);
    holder.innerHTML = '<svg width="0" height="0" aria-hidden="true"><filter id="' + id +
      '" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="' + values + '"/></filter></svg>';
    var svg = holder.firstElementChild;
    svg.style.setProperty('position', 'absolute');
    svg.style.setProperty('overflow', 'hidden');
    body.appendChild(svg);
    known.ids[key] = id;
    return id;
  }

  function readImagePixels(source, doc, filter) {
    var w = source.naturalWidth, h = source.naturalHeight;
    if (!w || !h) return null;
    var scale = Math.min(1, 128 / Math.max(w, h));
    var canvas = docCall(doc, 'createElement', ['canvas']);
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    var usable = filter && !/url\(/i.test(filter);
    var native = usable && 'filter' in ctx;
    if (native) ctx.filter = filter;
    try {
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return usable && !native ? filterPixels(data, filter) : data;
    } catch (e) {
      return null;
    }
  }

  function filterPixels(data, filter) {
    var steps = [];
    filter.replace(/(brightness|invert|grayscale|contrast|opacity)\(\s*([\d.]+)(%?)\s*\)/gi, function (m, name, amount, percent) {
      steps.push({ name: name.toLowerCase(), a: parseFloat(amount) / (percent ? 100 : 1) });
      return m;
    });
    if (!steps.length) return data;
    var out = new Uint8ClampedArray(data.length);
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i], g = data[i + 1], b = data[i + 2], al = data[i + 3];
      for (var k = 0; k < steps.length; k++) {
        var a = steps[k].a;
        switch (steps[k].name) {
          case 'brightness': r *= a; g *= a; b *= a; break;
          case 'invert': a = Math.min(1, a); r += (255 - 2 * r) * a; g += (255 - 2 * g) * a; b += (255 - 2 * b) * a; break;
          case 'grayscale':
            a = Math.min(1, a);
            var y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            r += (y - r) * a; g += (y - g) * a; b += (y - b) * a;
            break;
          case 'contrast': r = (r - 127.5) * a + 127.5; g = (g - 127.5) * a + 127.5; b = (b - 127.5) * a + 127.5; break;
          default: al *= Math.min(1, a);
        }
        r = Math.min(255, Math.max(0, r)); g = Math.min(255, Math.max(0, g)); b = Math.min(255, Math.max(0, b));
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = al;
    }
    return out;
  }

  function whenLoaded(img) {
    if (img.complete) return Promise.resolve(img.naturalWidth > 0);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(false); }, 10000);
      img.addEventListener('load', function () { clearTimeout(timer); resolve(true); }, { once: true });
      img.addEventListener('error', function () { clearTimeout(timer); resolve(false); }, { once: true });
    });
  }

  function loadCorsCopy(src, doc) {
    if (!/^https?:/i.test(src)) return Promise.resolve(null);
    var copy = docCall(doc, 'createElement', ['img']);
    copy.crossOrigin = 'anonymous';
    copy.referrerPolicy = 'no-referrer';
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(null); }, 8000);
      copy.onload = function () { clearTimeout(timer); resolve(copy); };
      copy.onerror = function () { clearTimeout(timer); resolve(null); };
      copy.src = src;
    });
  }

  var imageJobs = new WeakMap();

  function flipIfNeeded(img, bg, original, remoteContentAllowed) {
    var doc = img.ownerDocument;
    var loaded = false;
    var job = imageJobs.get(img);
    if (!job) {
      var view = docPart(doc, 'defaultView');
      var computed = view ? view.getComputedStyle(img).filter : '';
      job = {
        sender: computed && computed !== 'none' ? computed : '',
        inline: img.style.getPropertyValue('filter'),
        priority: img.style.getPropertyPriority('filter'),
        turn: 0
      };
      imageJobs.set(img, job);
    }
    var turn = ++job.turn;
    return whenLoaded(img).then(function (ok) {
      if (!ok || (img.naturalWidth <= 2 && img.naturalHeight <= 2)) return null;
      loaded = true;
      var pixels = readImagePixels(img, doc, job.sender);
      if (pixels || !remoteContentAllowed) return pixels;
      return loadCorsCopy(img.currentSrc || img.src, doc).then(function (copy) { return copy ? readImagePixels(copy, doc, job.sender) : null; });
    }).then(function (pixels) {
      if (!loaded || !img.isConnected || job.turn !== turn) return;
      if (!pixels) {
        img.style.setProperty('background-color', formatColor(original), 'important');
        return;
      }
      var id = judgeImagePixels(pixels, bg) === 'flip' ? flipFilterId(doc, bg) : null;
      if (id) img.style.setProperty('filter', (job.sender ? job.sender + ' ' : '') + 'url(#' + id + ')', 'important');
      else if (job.inline) img.style.setProperty('filter', job.inline, job.priority);
      else img.style.removeProperty('filter');
    });
  }

  var SINGLE_URL = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)$/i;

  function solidColor(data) {
    if (!data || data.length < 4) return null;
    var r = data[0], g = data[1], b = data[2];
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 250 || Math.abs(data[i] - r) > 6 || Math.abs(data[i + 1] - g) > 6 || Math.abs(data[i + 2] - b) > 6) return null;
    }
    return { r: r, g: g, b: b, a: 1 };
  }

  function readSolidPicture(src, doc, remoteContentAllowed) {
    if (/^https?:/i.test(src)) {
      if (!remoteContentAllowed) return Promise.resolve(null);
      return loadCorsCopy(src, doc).then(function (copy) { return copy ? solidColor(readImagePixels(copy, doc)) : null; });
    }
    if (!/^(?:data|blob):/i.test(src)) return Promise.resolve(null);
    var img = docCall(doc, 'createElement', ['img']);
    img.src = src;
    return whenLoaded(img).then(function (ok) { return ok ? solidColor(readImagePixels(img, doc)) : null; });
  }

  var BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
  var SKIP_TAGS = { IMG: 1, VIDEO: 1, CANVAS: 1, SOURCE: 1, svg: 1, SVG: 1, STYLE: 1, SCRIPT: 1, BR: 1, WBR: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1 };

  function hasImage(backgroundImage) {
    if (!backgroundImage || backgroundImage === 'none') return false;
    return /url\(/i.test(backgroundImage.replace(/url\(\s*(?:""|''|)\s*\)/gi, ''));
  }

  var converted = new WeakMap();

  function apply(doc, options) {
    options = options || {};
    var win = docPart(doc, 'defaultView');
    var body = docPart(doc, 'body');
    var html = docPart(doc, 'documentElement');
    if (converted.has(doc)) return converted.get(doc);
    var imagePass = Promise.resolve();
    var holdReveal = false;
    try {
      if (!win || !body || !html) return imagePass;
      converted.set(doc, imagePass);
      var given = typeof options.canvas === 'string' ? parseColor(options.canvas, doc) : options.canvas;
      var canvas = given && given.a > 0 ? given : DEFAULT_CANVAS;
      var darken = function (c) { return darkenBackground(c, canvas); };

      html.classList.remove(PENDING_CLASS);
      var htmlStyle = win.getComputedStyle(html);
      var painted = parseColor(htmlStyle.backgroundColor, doc);
      var mailCanvas = painted && painted.a === 1 ? painted : null;
      var base = mailCanvas ? darken(mailCanvas) : canvas;

      var elements = [body];
      var all = body.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (!SKIP_TAGS[all[i].tagName] && !all[i].closest('svg')) elements.push(all[i]);
      }

      var snaps = elements.map(function (el) {
        var cs = win.getComputedStyle(el);
        return {
          el: el,
          color: parseColor(cs.color, doc),
          bg: parseColor(cs.backgroundColor, doc),
          bgImage: cs.backgroundImage,
          bgCovers: /^repeat( repeat)?$/.test(cs.backgroundRepeat || 'repeat') || /^(cover|100% 100%)$/.test(cs.backgroundSize || ''),
          overlaps: (cs.position || 'static') !== 'static' || (cs.cssFloat || cs.getPropertyValue('float') || 'none') !== 'none' ||
            (cs.transform && cs.transform !== 'none') ||
            ['top', 'right', 'bottom', 'left'].some(function (side) { return parseFloat(cs.getPropertyValue('margin-' + side)) < 0; }),
          underlay: (cs.position || 'static') !== 'static' && parseInt(cs.zIndex, 10) < 0,
          opacity: parseFloat(cs.opacity),
          shown: cs.display !== 'none' && cs.visibility !== 'hidden',
          display: cs.display,
          otherPaint: paintsBeyondText(cs),
          borders: BORDER_SIDES.map(function (side) {
            return cs.getPropertyValue('border-' + side + '-style') !== 'none' && parseFloat(cs.getPropertyValue('border-' + side + '-width')) > 0
              ? parseColor(cs.getPropertyValue('border-' + side + '-color'), doc)
              : null;
          })
        };
      });

      var snapOf = new Map();
      snaps.forEach(function (snap) {
        snapOf.set(snap.el, snap);
        var box = snap.el === body ? null : snapOf.get(snap.el.parentElement);
        if (box && /grid/.test(box.display || '')) snap.overlaps = true;
      });
      var still = function (snap) {
        return !(snap.bg && snap.bg.a > 0) && (!snap.bgImage || snap.bgImage === 'none') && !snap.overlaps && !snap.otherPaint;
      };
      var hasText = function (el) {
        for (var ch = el.firstChild; ch; ch = ch.nextSibling) {
          if (ch.nodeType === 3 && /\S/.test(ch.nodeValue)) return true;
        }
        return false;
      };
      var generates = function (el) {
        return ['::before', '::after'].some(function (pseudo) {
          var content = win.getComputedStyle(el, pseudo).content;
          return !!content && content !== 'none' && content !== 'normal';
        });
      };
      var pictureOpacity = new Map();
      var pictureStill = function (pic) {
        var all = [pic].concat(Array.prototype.slice.call(pic.querySelectorAll(PICTURE_TAGS)));
        return all.every(function (p) {
          var ps = win.getComputedStyle(p);
          if (!pictureOpacity.has(p)) pictureOpacity.set(p, parseFloat(ps.opacity));
          return !outOfFlow(ps) && !paintsBeyondText(ps);
        });
      };
      var under = new Map();
      snaps.forEach(function (snap) {
        under.set(snap.el, snap.opacity < 1 || (snap.el !== body && !!under.get(snap.el.parentElement)));
      });
      for (var r = snaps.length - 1; r >= 0; r--) {
        var sn = snaps[r];
        if (!under.get(sn.el)) continue;
        var calm = still(sn) && sn.display !== 'list-item' && !generates(sn.el);
        var text = hasText(sn.el);
        var weakest = 1;
        for (var c = 0; c < sn.el.children.length; c++) {
          var child = sn.el.children[c];
          var cs3 = child.tagName === 'PICTURE' ? null : snapOf.get(child);
          if (cs3) {
            calm = calm && cs3.calm;
            if (cs3.shown) {
              text = text || cs3.text;
              weakest = Math.min(weakest, (cs3.opacity < 1 ? cs3.opacity : 1) * cs3.weakest);
            }
          } else if (child.matches(PICTURE_TAGS)) {
            calm = calm && pictureStill(child);
          }
        }
        sn.calm = calm;
        sn.text = sn.shown && text;
        sn.weakest = weakest;
      }
      var BLOCKED = -1;
      var chainAt = new Map();
      var pageFade = parseFloat(htmlStyle.opacity);
      snaps.forEach(function (snap) {
        var above = snap.el === body ? (pageFade < 1 ? BLOCKED : 1) : chainAt.get(snap.el.parentElement);
        if (above === undefined) above = 1;
        if (above === BLOCKED || !(snap.opacity < 1)) { chainAt.set(snap.el, above); return; }
        var chain = above * snap.opacity;
        snap.fold = snap.shown && snap.calm && snap.text && chain * snap.weakest >= FOLD_MIN;
        chainAt.set(snap.el, snap.fold ? chain : BLOCKED);
      });
      var picturesIn = new Map();
      var allPictures = body.querySelectorAll(PICTURE_TAGS);
      for (var q = 0; q < allPictures.length; q++) {
        var pic = allPictures[q];
        if (pic.parentElement && pic.parentElement.closest(PICTURE_TAGS)) continue;
        for (var up = pic.parentElement; up; up = up.parentElement) {
          var us = snapOf.get(up);
          if (us && us.fold) {
            if (!picturesIn.has(up)) picturesIn.set(up, []);
            picturesIn.get(up).push(pic);
            break;
          }
        }
      }
      var fades = new Map();
      var fadeOf = function (el) {
        for (var n = el; n; n = n.parentElement) {
          if (fades.has(n)) return fades.get(n);
        }
        return 1;
      };

      var landsOnCanvas = function (next, under) { return closeTo(composite(next, under), canvas); };
      var underlay = snaps.some(function (snap) { return snap.underlay; });
      var rootClear = !underlay && (!htmlStyle.backgroundImage || htmlStyle.backgroundImage === 'none') &&
        (!mailCanvas || landsOnCanvas(base, canvas));
      var surfaces = new Map();
      var surfaceOf = function (el) {
        for (var n = el; n; n = n.parentElement) {
          var s = surfaces.get(n);
          if (s) return s;
        }
        return root;
      };

      var writes = [];
      var set = function (el, prop, value) {
        writes.push(function () { el.style.setProperty(prop, value, 'important'); });
      };
      var rootImage = htmlStyle.backgroundImage;
      var root = { bg: base, original: mailCanvas || WHITE, onImage: false, clear: rootClear };
      if (hasImage(rootImage)) {
        root = { bg: mailCanvas || canvas, original: mailCanvas || canvas, onImage: true, clear: false };
      } else {
        if (mailCanvas) set(html, 'background-color', rootClear ? 'transparent' : formatColor(base));
        var rootStops = gradientStops(rootImage, doc);
        if (rootStops.length) {
          var rootGradient = mapGradientColors(rootImage, darken, doc);
          if (rootGradient !== rootImage) set(html, 'background-image', rootGradient);
          root = gradientSurface(rootStops, darken, root.bg, root.original);
        }
      }

      var pictures = [];
      var finalText = new Map();
      var kept = new Map();
      var keptOf = function (el) {
        for (var n = el; n; n = n.parentElement) {
          if (kept.has(n)) return kept.get(n);
        }
        return 1;
      };
      var convert = function (snap) {
        var el = snap.el;
        var parent = el === body ? root : surfaceOf(el.parentElement);
        var surface = parent;
        var inherited = el === body ? null : finalText.get(el.parentElement);
        var keep = (el === body ? 1 : keptOf(el.parentElement)) * (!snap.fold && snap.opacity < 1 ? snap.opacity : 1);
        kept.set(el, keep);

        if (hasImage(snap.bgImage)) {
          var fill = snap.bg && snap.bg.a > 0 ? composite(snap.bg, parent.bg) : parent.bg;
          surface = { bg: fill, original: fill, onImage: true, clear: false };
          if (!parent.onImage && snap.color) {
            set(el, 'color', formatColor(snap.color));
            finalText.set(el, { color: snap.color, changed: true });
          }
          var url = snap.bgCovers && SINGLE_URL.exec(snap.bgImage);
          if (url && !parent.onImage) pictures.push({ snap: snap, src: url[1] || url[2] || url[3] });
        } else {
          var stops = [];
          if (snap.bgImage && snap.bgImage !== 'none' && !parent.onImage) {
            var gradient = mapGradientColors(snap.bgImage, darken, doc);
            if (gradient !== snap.bgImage) set(el, 'background-image', gradient);
            if (snap.bgCovers) stops = gradientStops(snap.bgImage, doc);
          }
          var mayClear = parent.clear && !snap.overlaps && (!snap.bgImage || snap.bgImage === 'none');
          if (snap.bg && snap.bg.a > 0 && !(parent.onImage && snap.bg.a < 0.9)) {
            var next = darken(snap.bg);
            var original = composite(snap.bg, parent.original);
            var keptDark = snap.bg.a >= 0.9 && toLch(original).l <= DARK_L;
            var framed = snap.borders.some(function (b) { return !!b && b.a > 0; });
            if (keptDark && !framed && contrastRatio(original, parent.original) >= 3) next = liftApart(next, parent.bg, SEPARATION);
            var clear = mayClear && landsOnCanvas(next, parent.bg);
            surface = { bg: clear ? parent.bg : composite(next, parent.bg), original: original, onImage: false, clear: clear, kept: keptDark };
            if (clear) set(el, 'background-color', 'transparent');
            else if (!sameColor(next, snap.bg)) set(el, 'background-color', formatColor(next));
          } else if (parent.clear && !mayClear) {
            surface = { bg: parent.bg, original: parent.original, onImage: false, clear: false, kept: parent.kept };
          }
          if (stops.length) surface = gradientSurface(stops, darken, surface.bg, surface.original);
        }
        surfaces.set(el, surface);
        if (surface.onImage) return;

        var fade = (el === body ? 1 : fadeOf(el.parentElement)) * (snap.fold ? snap.opacity : 1);
        if (fade < 1) fades.set(el, fade);
        if (snap.fold) {
          set(el, 'opacity', '1');
          set(el, 'isolation', 'isolate');
          (picturesIn.get(el) || []).forEach(function (pic) {
            var own = pictureOpacity.has(pic) ? pictureOpacity.get(pic) : 1;
            set(pic, 'opacity', String(Math.round(own * fade * 1000) / 1000));
          });
        }

        if (snap.color) {
          var sent = fade < 1 ? { r: snap.color.r, g: snap.color.g, b: snap.color.b, a: snap.color.a * fade } : snap.color;
          var text = adaptTextColor(sent, surface.bg, surface.original, keep >= FOLD_MIN ? keep : 1);
          var changed = !sameColor(text, snap.color);
          if (changed || (inherited && inherited.changed && !sameColor(text, inherited.color))) {
            set(el, 'color', formatColor(text));
            set(el, 'text-decoration-color', formatColor(text));
          }
          finalText.set(el, { color: text, changed: changed || !!(inherited && inherited.changed) });
        }
        snap.borders.forEach(function (border, side) {
          if (!border || border.a === 0) return;
          var drawn = fade < 1 ? { r: border.r, g: border.g, b: border.b, a: border.a * fade } : border;
          var nb = parent.kept ? drawn
            : surface.kept && surface !== parent ? liftApart(drawn, parent.bg, FRAME_MIN)
              : adaptBorderColor(drawn, parent.bg, canvas);
          if (!sameColor(nb, border)) set(el, 'border-' + BORDER_SIDES[side] + '-color', formatColor(nb));
        });
      };
      snaps.forEach(convert);

      var remoteAllowed = !!options.remoteContentAllowed;
      var flipImages = function (within) {
        var imgs = within.querySelectorAll('img');
        var jobs = [];
        for (var j = 0; j < imgs.length; j++) {
          var s = surfaceOf(imgs[j].parentElement);
          if (s.onImage || s.bg === s.original) continue;
          if (toLch(s.original).l < 0.7 || contrastRatio(s.original, s.bg) < 3) continue;
          jobs.push(flipIfNeeded(imgs[j], s.bg, s.original, remoteAllowed).catch(function () {}));
        }
        return Promise.all(jobs);
      };
      var flush = function () {
        var pending = writes;
        writes = [];
        pending.forEach(function (write) { write(); });
      };

      flush();
      var flipped = flipImages(body);
      var found = pictures;
      var pictureFlips = [];
      var resolve = function (list, depth) {
        pictures = [];
        if (!list.length || depth > 4) return Promise.resolve();
        return Promise.all(list.map(function (p) {
          return readSolidPicture(p.src, doc, remoteAllowed).catch(function () { return null; });
        })).then(function (colors) {
          list.forEach(function (p, k) {
            var el = p.snap.el;
            if (!colors[k] || !el.isConnected) return;
            p.snap.bgImage = 'none';
            p.snap.bg = colors[k];
            set(el, 'background-image', 'none');
            set(el, 'background-color', formatColor(colors[k]));
            var from = snaps.indexOf(p.snap);
            for (var n = from; n < snaps.length && (n === from || el.contains(snaps[n].el)); n++) convert(snaps[n]);
            flush();
            pictureFlips.push(flipImages(el));
          });
          return resolve(pictures, depth + 1);
        });
      };
      var solids = resolve(found, 0);
      if (found.length) {
        holdReveal = true;
        html.classList.add(PENDING_CLASS);
        var reveal = function () { html.classList.remove(PENDING_CLASS); };
        solids.then(reveal, reveal);
        setTimeout(reveal, 400);
      }
      imagePass = Promise.all([flipped, solids.then(function () { return Promise.all(pictureFlips); })]).then(function () {});
      converted.set(doc, imagePass);
    } finally {
      if (html && !holdReveal) html.classList.remove(PENDING_CLASS);
    }
    return imagePass;
  }

  return {
    parseComputedColor: parseComputedColor,
    parseColor: parseColor,
    formatColor: formatColor,
    contrastRatio: contrastRatio,
    darkenBackground: darkenBackground,
    adaptTextColor: adaptTextColor,
    readSurfaceColor: readSurfaceColor,
    judgeImagePixels: judgeImagePixels,
    flipFilterMatrix: flipFilterMatrix,
    hasImage: hasImage,
    apply: apply
  };
});
