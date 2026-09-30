'use strict';
// One drawing routine for every icon: the on-screen preview, the list
// thumbnails and the 1024px PNG that becomes the real app icon.

(function () {
  // Claude-style burst: a dozen rounded rays of uneven length.
  const RAYS = [1.0, 0.72, 0.92, 0.66, 1.0, 0.78, 0.9, 0.7, 0.98, 0.74, 0.88, 0.68];

  function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62;
  }

  function burst(ctx, cx, cy, radius, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineWidth = radius * 0.19;
    RAYS.forEach((len, i) => {
      const a = (i * Math.PI * 2) / RAYS.length + 0.18;
      const r0 = radius * 0.14; const r1 = radius * (0.38 + 0.62 * len);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    });
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Draw the icon into an existing canvas of any size. */
  function draw(canvas, color, badge) {
    const s = canvas.width;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    const fg = isLight(color) ? '#1F2328' : '#FFFFFF';
    const pad = s * 0.04;
    roundRect(ctx, pad, pad, s - 2 * pad, s - 2 * pad, s * 0.22);
    ctx.fillStyle = color; ctx.fill();

    const b = (badge || '').trim().slice(0, 2).toUpperCase();
    const radius = s * (b ? 0.26 : 0.32);
    burst(ctx, b ? s * 0.42 : s / 2, b ? s * 0.42 : s / 2, radius, fg);
    if (b) {
      const r = s * 0.25; const bx = s * 0.7; const by = s * 0.7;
      ctx.beginPath(); ctx.arc(bx, by, r + pad, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fillStyle = fg; ctx.fill();
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(r * (b.length === 1 ? 1.15 : 0.85))}px -apple-system, "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(b, bx, by + r * 0.04);
    }
  }

  /** Sharp on retina: size in CSS px, backing store scaled. */
  function paint(canvas, cssSize, color, badge) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssSize * dpr); canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = `${cssSize}px`; canvas.style.height = `${cssSize}px`;
    draw(canvas, color, badge);
  }

  /** The 1024px PNG (base64, no prefix) handed to the main process. */
  function toPngBase64(color, badge) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 1024;
    draw(c, color, badge);
    return c.toDataURL('image/png').split(',')[1];
  }

  window.IconRender = { paint, toPngBase64, isLight };
})();
