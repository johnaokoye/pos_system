// The branch the website's retail side sells from: its stock is what the
// online catalogue shows (GET /products?online=1, /products/:id?online=1) and
// online orders placed with an API key and no branch are raised there.
// Settings → Website → Online Retail Store (`website_retail_branch_id`); blank
// = the Ecommerce Sync branch (`woo_sync_branch_id`), the figure used before
// this setting existed; neither = company-wide stock and no branch.
async function onlineRetailBranchId(db) {
  const { rows } = await db.execute({ sql: "SELECT key, value FROM settings WHERE key IN ('website_retail_branch_id', 'woo_sync_branch_id')", args: [] });
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return Number(s.website_retail_branch_id) || Number(s.woo_sync_branch_id) || null;
}

module.exports = { onlineRetailBranchId };
