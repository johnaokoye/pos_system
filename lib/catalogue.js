const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Renders a product catalogue PDF (routes/catalogues.js GET /:id/pdf) onto
// `out` (the HTTP response): a cover page with the company logo, the
// catalogue's name and description, then products grouped by category in a
// 3-column grid of cards (image, name, SKU, price, short description), with
// a running header and "Page X of Y" footer on every page after the cover.

const PAGE = { size: 'LETTER', margin: 40 };
const COLS = 3, GAP = 12, CARD_H = 200, IMG_H = 110;
const UPLOADS_ROOT = path.join(__dirname, '..');

// PDFKit can only embed JPEG and PNG — anything else (WebP, GIF) is skipped
// and the card shows a "No image" placeholder instead.
function embeddable(buf) {
  if (!buf || buf.length < 4) return false;
  return (buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47);
}

// Local /uploads/... paths are read from disk; Cloudinary URLs are fetched
// at a reduced width (a w_500 transformation) so a large catalogue doesn't
// embed full-resolution originals. Never throws — a missing or broken
// image just yields null.
async function loadImage(src) {
  if (!src) return null;
  try {
    let buf;
    if (/^https?:\/\//.test(src)) {
      const url = src.includes('res.cloudinary.com') && src.includes('/upload/') ? src.replace('/upload/', '/upload/w_500,c_limit,f_jpg/') : src;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return null;
        buf = Buffer.from(await r.arrayBuffer());
      } finally { clearTimeout(t); }
    } else {
      const file = path.join(UPLOADS_ROOT, src.replace(/^\/+/, ''));
      if (!file.startsWith(path.join(UPLOADS_ROOT, 'uploads'))) return null;
      buf = await fs.promises.readFile(file);
    }
    return embeddable(buf) ? buf : null;
  } catch { return null; }
}

// Loads every image up front, a few at a time, keyed by its path.
async function loadImages(srcs, concurrency = 8) {
  const unique = [...new Set(srcs.filter(Boolean))];
  const map = new Map();
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (i < unique.length) {
      const src = unique[i++];
      map.set(src, await loadImage(src));
    }
  }));
  return map;
}

function moneyFormatter(currency) {
  try {
    const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' });
    return n => f.format(n || 0);
  } catch { return n => (n || 0).toFixed(2); }
}

// Text clipped to `lines` lines at `width` — PDFKit's own ellipsis option
// needs a fixed height, which is what this computes.
function clippedText(doc, text, x, y, width, lines, opts = {}) {
  const lineH = doc.currentLineHeight(true);
  doc.text(text || '', x, y, { width, height: lineH * lines, ellipsis: true, lineBreak: true, ...opts });
}

async function renderCataloguePdf(out, { catalogue, products, settings }) {
  const fmt = moneyFormatter(settings.currency);
  const storeName = settings.store_name || 'Product Catalogue';
  const images = await loadImages([settings.company_logo_url, ...products.map(p => p.image_path)]);

  const doc = new PDFDocument({ ...PAGE, bufferPages: true, info: { Title: catalogue.name, Author: storeName } });
  doc.pipe(out);
  const W = doc.page.width, H = doc.page.height, M = PAGE.margin;
  const innerW = W - M * 2;

  // ── Cover ──
  let y = 120;
  const logo = images.get(settings.company_logo_url);
  if (logo) {
    try { doc.image(logo, M, y, { fit: [innerW, 110], align: 'center', valign: 'center' }); y += 130; } catch { /* unreadable logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#555').text(storeName, M, y, { width: innerW, align: 'center' });
  y = doc.y + 40;
  doc.moveTo(M + 60, y).lineTo(W - M - 60, y).lineWidth(1).strokeColor('#ccc').stroke();
  y += 30;
  doc.font('Helvetica-Bold').fontSize(30).fillColor('#111').text(catalogue.name, M, y, { width: innerW, align: 'center' });
  if (catalogue.description) {
    doc.moveDown(0.8).font('Helvetica').fontSize(13).fillColor('#444').text(catalogue.description, M + 40, doc.y, { width: innerW - 80, align: 'center' });
  }
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.moveDown(2).font('Helvetica').fontSize(11).fillColor('#777')
    .text(`${products.length} product${products.length === 1 ? '' : 's'}  ·  ${dateStr}`, M, doc.y, { width: innerW, align: 'center' });
  const contact = [settings.store_address, settings.store_phone, settings.store_email].filter(Boolean).join('  ·  ');
  doc.font('Helvetica').fontSize(9).fillColor('#777');
  if (catalogue.show_prices) doc.text('Prices shown exclude tax and are subject to change.', M, H - M - 40, { width: innerW, align: 'center' });
  if (contact) doc.text(contact, M, H - M - 24, { width: innerW, align: 'center' });

  // ── Product pages ──
  const cardW = (innerW - GAP * (COLS - 1)) / COLS;
  const top = M + 28, bottom = H - M - 24;
  let col = 0;
  const newPage = () => { doc.addPage(); y = top; col = 0; };

  const groups = new Map();
  for (const p of products) {
    const key = p.category_name || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  newPage();
  for (const [category, items] of groups) {
    // Category heading — never left stranded at the bottom of a page.
    if (col !== 0) { y += CARD_H + GAP; col = 0; }
    if (y + 30 + CARD_H > bottom) newPage();
    doc.rect(M, y, innerW, 22).fill('#1f2937');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text(category.toUpperCase(), M + 10, y + 6, { width: innerW - 20, lineBreak: false });
    y += 30;

    for (const p of items) {
      if (y + CARD_H > bottom) newPage();
      const x = M + col * (cardW + GAP);
      doc.roundedRect(x, y, cardW, CARD_H, 4).lineWidth(0.6).strokeColor('#d1d5db').stroke();

      const img = images.get(p.image_path);
      let drawn = false;
      if (img) {
        try { doc.image(img, x + 8, y + 8, { fit: [cardW - 16, IMG_H], align: 'center', valign: 'center' }); drawn = true; } catch { /* corrupt image */ }
      }
      if (!drawn) {
        doc.rect(x + 8, y + 8, cardW - 16, IMG_H).fill('#f3f4f6');
        doc.font('Helvetica').fontSize(9).fillColor('#9ca3af').text('No image', x + 8, y + 8 + IMG_H / 2 - 5, { width: cardW - 16, align: 'center' });
      }

      let ty = y + IMG_H + 14;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111');
      clippedText(doc, p.name, x + 8, ty, cardW - 16, 2);
      ty += doc.currentLineHeight(true) * 2 + 2;
      const meta = [p.sku ? `SKU ${p.sku}` : '', p.brand || ''].filter(Boolean).join('  ·  ');
      doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280').text(meta, x + 8, ty, { width: cardW - 16, lineBreak: false, ellipsis: true });
      ty += 11;
      if (p.description) {
        doc.font('Helvetica').fontSize(7.5).fillColor('#374151');
        clippedText(doc, p.description, x + 8, ty, cardW - 16, 2);
      }
      if (catalogue.show_prices) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#047857').text(fmt(p.price), x + 8, y + CARD_H - 20, { width: cardW - 16, align: 'right', lineBreak: false });
      }

      col++;
      if (col === COLS) { col = 0; y += CARD_H + GAP; }
    }
  }

  // Running header + "Page X of Y" on every product page (not the cover).
  const range = doc.bufferedPageRange();
  const total = range.count - 1;
  for (let i = range.start + 1; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Drawing in the bottom margin would otherwise auto-add a page.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text(catalogue.name, M, M - 4, { width: innerW / 2, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(storeName, M + innerW / 2, M - 4, { width: innerW / 2, align: 'right', lineBreak: false, ellipsis: true });
    doc.moveTo(M, M + 12).lineTo(W - M, M + 12).lineWidth(0.5).strokeColor('#d1d5db').stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(`Page ${i - range.start} of ${total}`, M, H - M + 4, { width: innerW, align: 'center', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
}

module.exports = { renderCataloguePdf, loadImage };
