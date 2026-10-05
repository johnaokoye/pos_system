const path = require('path');
const fs = require('fs');

// uploads/ subfolders that hold personal documents (customer ID and
// address-proof scans) or captured signatures. server.js only serves these
// to a signed-in session, so anything that leaves the app — an emailed
// document — can't link to them and must carry the image itself.
const PROTECTED_UPLOAD_DIRS = ['customer-ids', 'customer-reference-ids', 'customer-address-proofs', 'rental-signatures', 'po-approval-signatures'];

const UPLOADS_ROOT = path.join(__dirname, '../uploads');

// Rewrites every <img src> pointing at a protected local upload (relative
// /uploads/... or absolute http(s)://host/uploads/...) to a cid: reference
// and returns the matching nodemailer inline attachments. Usage:
//   const { html, attachments } = inlineProtectedImages(buildXHtml(...));
//   transporter.sendMail({ ..., html, attachments });
function inlineProtectedImages(html) {
  const attachments = [];
  const out = html.replace(/(<img\b[^>]*?\bsrc=")(?:https?:\/\/[^"\/]+)?\/uploads\/([\w-]+)\/([\w.-]+)"/g, (match, prefix, dir, file) => {
    if (!PROTECTED_UPLOAD_DIRS.includes(dir)) return match;
    const filePath = path.join(UPLOADS_ROOT, dir, file);
    if (!fs.existsSync(filePath)) return match;
    const cid = `upload-${attachments.length}@pos`;
    attachments.push({ filename: file, path: filePath, cid });
    return `${prefix}cid:${cid}"`;
  });
  return { html: out, attachments };
}

module.exports = { PROTECTED_UPLOAD_DIRS, inlineProtectedImages };
