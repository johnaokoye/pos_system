const path = require('path');
const fs = require('fs');
const { cloudUpload } = require('./cloudinary');

// A canvas signature pad gives us a base64 PNG client-side, so this skips
// multer/multipart entirely — same cloudUpload-or-local-disk fallback the
// product image and PO attachment uploads use, just fed a decoded Buffer
// instead of req.file.buffer. Originally lived only in routes/rentals.js
// (customer + guard signatures at Issue/Return); shared here now that
// purchase order approvals also capture one.
async function uploadSignature(dataUrl, filenamePrefix, folder = 'signatures') {
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  const cloudResult = await cloudUpload(buffer, {
    folder: `pos-system/${folder}`,
    public_id: `${filenamePrefix}-${Date.now()}`,
    overwrite: true,
    resource_type: 'image',
  });
  if (cloudResult) return cloudResult.secure_url;
  const dir = path.join(__dirname, `../uploads/${folder}`);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${filenamePrefix}-${Date.now()}.${match[1]}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/${folder}/${filename}`;
}

// Approvals (POs, purchase requests, Special Projects) are signed with the
// approver's saved signature (employees.approval_signature). A newly drawn
// one (`dataUrl`) replaces the saved one first — that's how it's collected
// the first time, and how someone changes it. Returns the image path to
// stamp on the document; documents keep that path, so a later change never
// alters what an earlier approval showed (files are never overwritten).
async function resolveApprovalSignature(db, employeeId, dataUrl) {
  if (!employeeId) throw Object.assign(new Error('Approving needs a signed-in employee'), { status: 400 });
  if (dataUrl) {
    const url = await uploadSignature(dataUrl, `employee-${employeeId}`, 'approval-signatures');
    if (!url) throw Object.assign(new Error("The signature couldn't be read — draw it again"), { status: 400 });
    await db.execute({ sql: 'UPDATE employees SET approval_signature = ? WHERE id = ?', args: [url, employeeId] });
    return url;
  }
  const { rows: [emp] } = await db.execute({ sql: 'SELECT approval_signature FROM employees WHERE id = ?', args: [employeeId] });
  if (!emp?.approval_signature) throw Object.assign(new Error('Draw your signature to approve — it\'s saved for your future approvals'), { status: 400, code: 'signature_required' });
  return emp.approval_signature;
}

module.exports = { uploadSignature, resolveApprovalSignature };
