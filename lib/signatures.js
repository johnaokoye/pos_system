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

module.exports = { uploadSignature };
