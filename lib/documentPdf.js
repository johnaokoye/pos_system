const PDFDocument = require('pdfkit');
const { loadImage } = require('./catalogue');

// Renders a customer-facing document (quotation, tax invoice) as a PDF
// Buffer — used by routes/email.js when staff choose "Attach as PDF". Each
// document type maps its own data onto the one generic model below (see the
// *PdfModel functions in routes/email.js), so every PDF shares one layout:
// branded header, title + reference details, customer box, line-item
// table(s), totals, notes, signatures, footer, "Page X of Y".
//
// model = {
//   store:      { name, branch, address, phone, logo }   logo: image path/URL
//   title, number,
//   meta:       [[label, value]]          right of the title (dates, branch…)
//   party:      { label, lines: [], boldFirst? }  "Bill To" / "Customer" box
//                                         (boldFirst: first line — the name — in bold)
//   info:       [[label, value]]          extra detail rows (rental period…)
//   tables:     [{ heading?, columns: [{ label, width, align }],
//                  rows: [{ cells: [], sub?, indent? }], mainCol? }]
//   totals:     [{ label, value, style? }]  style: 'muted' | 'green' | 'grand' | 'heading'
//                                         ('heading' starts a titled group, no value)
//   notes:      [string]
//   signatures: [{ label, name, signedAt, image }]   image: path/URL
//   signatureAlign: 'right'   optional — signatures in the right-hand third
//                             (e.g. the PO approver) instead of spread across
//   footer
// }
//
// Text is drawn in the built-in Helvetica, which only covers Latin-1 —
// symbols like ↳ are avoided in favour of indentation.

const GREEN = '#007e37', YELLOW = '#ffd800', BLACK = '#000000', GREY = '#666666', LIGHT = '#f3f4f6', RULE = '#e5e7eb';
const MARGIN = 48;

function renderDocumentPdf(model) {
  return new Promise(async (resolve, reject) => {
    try {
      const [logo, ...sigImages] = await Promise.all([
        loadImage(model.store?.logo),
        ...(model.signatures || []).map(sg => loadImage(sg.image)),
      ]);

      const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true, info: { Title: `${model.title} ${model.number || ''}`.trim(), Author: model.store?.name || '' } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width, contentW = W - MARGIN * 2;
      const bottom = () => doc.page.height - MARGIN - 20;
      const ensure = (h) => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = MARGIN; return true; } return false; };

      // ── Header band ────────────────────────────────────────────────────
      const store = model.store || {};
      const headerLines = [store.branch, store.address, store.phone].filter(Boolean);
      const headerH = 34 + headerLines.length * 12;
      doc.rect(0, 0, W, headerH).fill(GREEN);
      doc.rect(0, headerH, W, 5).fill(YELLOW);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text(store.name || '', MARGIN, 14, { width: contentW, align: 'center' });
      doc.font('Helvetica').fontSize(9);
      headerLines.forEach(l => doc.text(l, { width: contentW, align: 'center' }));
      doc.y = headerH + 22;

      // ── Title + meta ──────────────────────────────────────────────────
      const top = doc.y;
      let titleX = MARGIN;
      if (logo) {
        try { doc.image(logo, MARGIN, top, { fit: [90, 40] }); titleX = MARGIN + 100; } catch {}
      }
      doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(17).text(model.title || '', titleX, top, { width: contentW / 2 });
      if (model.number) doc.fillColor(GREY).font('Helvetica').fontSize(10).text(model.number, titleX, doc.y + 1);
      const leftBottom = Math.max(doc.y, logo ? top + 40 : 0);
      // Right-aligned "Label: value" lines — measured and placed explicitly,
      // since PDFKit's `continued` text doesn't right-align across fonts.
      const right = MARGIN + contentW;
      let metaY = top;
      (model.meta || []).forEach(([label, value]) => {
        if (value == null || value === '') return;
        doc.fontSize(9);
        const lw = doc.font('Helvetica-Bold').widthOfString(`${label}: `);
        const vw = doc.font('Helvetica').widthOfString(String(value));
        doc.fillColor(BLACK).font('Helvetica-Bold').text(`${label}: `, right - lw - vw, metaY, { lineBreak: false });
        doc.font('Helvetica').text(String(value), right - vw, metaY, { lineBreak: false });
        metaY += 13;
      });
      doc.y = Math.max(leftBottom, metaY) + 14;

      // ── Customer box ──────────────────────────────────────────────────
      const party = model.party;
      if (party && party.lines && party.lines.filter(Boolean).length) {
        const lines = party.lines.filter(Boolean);
        const boxH = 20 + lines.length * 12 + (party.boldFirst ? 2 : 0);
        const y0 = doc.y;
        doc.roundedRect(MARGIN, y0, contentW, boxH, 4).fillAndStroke(LIGHT, RULE);
        doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9).text(party.label || 'Customer', MARGIN + 10, y0 + 8);
        lines.forEach((l, i) => doc.font(party.boldFirst && i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(party.boldFirst && i === 0 ? 10.5 : 9).text(l, MARGIN + 10));
        doc.y = y0 + boxH + 10;
      }

      // ── Info rows ─────────────────────────────────────────────────────
      const info = (model.info || []).filter(([, v]) => v != null && v !== '');
      if (info.length) {
        doc.fontSize(9);
        info.forEach(([label, value]) => {
          ensure(14);
          doc.fillColor(BLACK).font('Helvetica-Bold').text(`${label}: `, MARGIN, doc.y, { width: contentW, continued: true }).font('Helvetica').text(String(value));
        });
        doc.moveDown(0.6);
      }

      // ── Tables ────────────────────────────────────────────────────────
      for (const table of model.tables || []) {
        if (!table.rows || !table.rows.length) continue;
        const totalWeight = table.columns.reduce((s, c) => s + (c.width || 1), 0);
        const cols = []; let x = MARGIN;
        table.columns.forEach(c => { const w = contentW * (c.width || 1) / totalWeight; cols.push({ ...c, x, w }); x += w; });
        const pad = 6;
        // Tall enough for the longest heading — a narrow column's label
        // ("ORIGINAL FEE") can wrap to a second line.
        doc.font('Helvetica-Bold').fontSize(8);
        const headH = Math.max(...cols.map(c => doc.heightOfString(c.label.toUpperCase(), { width: c.w - pad * 2 }))) + 10;
        const drawHead = () => {
          const y0 = doc.y;
          doc.rect(MARGIN, y0, contentW, headH).fill(LIGHT);
          doc.fillColor(GREY).font('Helvetica-Bold').fontSize(8);
          cols.forEach(c => doc.text(c.label.toUpperCase(), c.x + pad, y0 + 5, { width: c.w - pad * 2, align: c.align || 'left' }));
          doc.y = y0 + headH;
        };
        if (table.heading) {
          ensure(40);
          doc.fillColor(GREY).font('Helvetica-Bold').fontSize(9).text(table.heading.toUpperCase(), MARGIN, doc.y);
          doc.moveDown(0.3);
        }
        ensure(36);
        drawHead();
        // The item column — where indent and the grey sub-line go — is the
        // first one unless the table says otherwise (mainCol, e.g. 1 when a
        // SKU column comes first).
        const mc = table.mainCol || 0;
        for (const row of table.rows) {
          doc.font('Helvetica').fontSize(9);
          const indent = row.indent ? 14 : 0;
          const firstW = cols[mc].w - pad * 2 - indent;
          const mainH = doc.heightOfString(String(row.cells[mc] ?? ''), { width: firstW });
          const subH = row.sub ? doc.fontSize(8).heightOfString(row.sub, { width: firstW }) + 2 : 0;
          doc.fontSize(9);
          const otherH = Math.max(0, ...cols.map((c, i) => i === mc ? 0 : doc.heightOfString(String(row.cells[i] ?? ''), { width: c.w - pad * 2 })));
          const rowH = Math.max(mainH + subH, otherH, 11) + pad * 2;
          if (ensure(rowH)) drawHead();
          const y0 = doc.y;
          cols.forEach((c, i) => {
            const val = row.cells[i] == null ? '' : String(row.cells[i]);
            doc.fillColor(BLACK).font(i === cols.length - 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
              .text(val, c.x + pad + (i === mc ? indent : 0), y0 + pad, { width: c.w - pad * 2 - (i === mc ? indent : 0), align: c.align || 'left' });
          });
          if (row.sub) doc.fillColor(GREY).font('Helvetica').fontSize(8).text(row.sub, cols[mc].x + pad + indent, y0 + pad + mainH + 2, { width: firstW });
          doc.moveTo(MARGIN, y0 + rowH).lineTo(MARGIN + contentW, y0 + rowH).lineWidth(0.5).strokeColor(RULE).stroke();
          doc.y = y0 + rowH;
        }
        doc.moveDown(0.8);
      }

      // ── Totals ────────────────────────────────────────────────────────
      const totals = (model.totals || []).filter(Boolean);
      if (totals.length) {
        const tw = 290, tx = MARGIN + contentW - tw;
        ensure(totals.length * 16 + 20);
        for (const t of totals) {
          if (t.style === 'heading') {
            if (t !== totals[0]) doc.y += 8;
            ensure(40);
            doc.fillColor(GREY).font('Helvetica-Bold').fontSize(8.5).text(t.label.toUpperCase(), tx, doc.y, { width: tw });
            doc.moveTo(tx, doc.y + 1).lineTo(tx + tw, doc.y + 1).lineWidth(0.5).strokeColor(RULE).stroke();
            doc.y += 5;
            continue;
          }
          if (t.style === 'grand') {
            doc.moveTo(tx, doc.y + 2).lineTo(tx + tw, doc.y + 2).lineWidth(1.5).strokeColor(BLACK).stroke();
            doc.y += 8;
          }
          const y0 = doc.y;
          const size = t.style === 'grand' ? 13 : (t.style === 'muted' ? 8.5 : 9.5);
          const color = t.style === 'green' ? GREEN : (t.style === 'muted' ? GREY : BLACK);
          const font = t.style === 'grand' ? 'Helvetica-Bold' : 'Helvetica';
          // The label gets whatever width the value doesn't need, so a long
          // label ("TOTAL DUE AT CHECKOUT") stays on one line.
          doc.fillColor(color).font(font).fontSize(size);
          const vw = doc.widthOfString(String(t.value));
          doc.text(t.label, tx, y0, { width: tw - vw - 10 });
          const labelBottom = doc.y;
          doc.text(String(t.value), tx + tw - vw - 1, y0, { width: vw + 2, align: 'right', lineBreak: false });
          doc.y = Math.max(labelBottom, y0 + size + 5);
        }
        doc.moveDown(0.8);
      }

      // ── Notes ─────────────────────────────────────────────────────────
      for (const note of (model.notes || []).filter(Boolean)) {
        ensure(30);
        doc.fillColor('#444444').font('Helvetica').fontSize(9).text(note, MARGIN, doc.y, { width: contentW });
        doc.moveDown(0.5);
      }

      // ── Signatures (one row, up to 4) ─────────────────────────────────
      const sigs = (model.signatures || []).map((sg, i) => ({ ...sg, img: sigImages[i] })).slice(0, 4);
      if (sigs.length) {
        ensure(80);
        doc.moveDown(0.5);
        const y0 = doc.y;
        const right = model.signatureAlign === 'right';
        const sw = right ? contentW / 3 : contentW / sigs.length;
        sigs.forEach((sg, i) => {
          const sx = right ? MARGIN + contentW - sw * (sigs.length - i) : MARGIN + sw * i;
          if (sg.img) { try { doc.image(sg.img, sx + 10, y0, { fit: [sw - 20, 40], align: 'center' }); } catch {} }
          doc.moveTo(sx + 10, y0 + 44).lineTo(sx + sw - 10, y0 + 44).lineWidth(0.5).strokeColor('#333333').stroke();
          doc.fillColor('#444444').font('Helvetica').fontSize(7.5).text(`${sg.label}${sg.name ? ` - ${sg.name}` : ''}`, sx + 4, y0 + 48, { width: sw - 8, align: 'center' });
          if (sg.signedAt) doc.fillColor(GREY).fontSize(7).text(sg.signedAt, sx + 4, doc.y, { width: sw - 8, align: 'center' });
        });
        doc.y = y0 + 76;
      }

      // ── Footer ────────────────────────────────────────────────────────
      if (model.footer) {
        ensure(24);
        doc.moveDown(0.8);
        doc.fillColor(GREY).font('Helvetica-Oblique').fontSize(9).text(model.footer, MARGIN, doc.y, { width: contentW, align: 'center' });
      }

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        // Drawn inside the bottom margin — zero it first, or PDFKit treats
        // text past the margin as overflow and adds a blank page.
        doc.page.margins.bottom = 0;
        doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
          .text(`${model.title || ''} ${model.number || ''}  ·  Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN + 6, { width: contentW, align: 'center', lineBreak: false });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { renderDocumentPdf };
