// Phone numbers as comparable keys, for spotting the same customer twice
// (routes/customers.js findDuplicateCustomers — the add form, edits and the
// CSV import). A phone field can hold several numbers ("876-975-4271/618-0223",
// "876 603- 4230 or 909-1234"), a bare 7-digit local number, a leading 1, or a
// trailing extension digit — each number becomes its own 10-digit key:
//   - split on / , ; & "or" and runs of spaces
//   - 11 digits starting with 1 → drop the 1; longer → the first 10
//   - 7 digits → the area code of the number before it in the same field,
//     else LOCAL_AREA_CODE
//   - placeholders (the last 7 digits all one digit, e.g. 000-0000) are
//     ignored, so they don't make unrelated customers look like duplicates
// Keys are stored per customer in customer_phone_keys (indexed), refreshed
// by syncPhoneKeys whenever a customer's phone is written, and caught up at
// startup for anything that changed phone without it (customers.phone_keys_src
// holds the phone the keys were last built from).

const LOCAL_AREA_CODE = '876';

function phoneKeys(phone) {
  const keys = [];
  let area = LOCAL_AREA_CODE;
  for (const part of String(phone || '').split(/[\/,;&]|\bor\b|\s{2,}/i)) {
    let d = part.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    else if (d.length > 10) d = d.slice(0, 10);
    if (d.length === 7) d = area + d;
    if (d.length !== 10) continue;
    if (/^(\d)\1{6}$/.test(d.slice(3))) continue;
    area = d.slice(0, 3);
    if (!keys.includes(d)) keys.push(d);
  }
  return keys;
}

async function syncPhoneKeys(executor, customerId, phone) {
  await executor.execute({ sql: 'DELETE FROM customer_phone_keys WHERE customer_id = ?', args: [customerId] });
  for (const key of phoneKeys(phone)) {
    await executor.execute({ sql: 'INSERT INTO customer_phone_keys (customer_id, phone_key) VALUES (?, ?)', args: [customerId, key] });
  }
  await executor.execute({ sql: 'UPDATE customers SET phone_keys_src = ? WHERE id = ?', args: [phone || '', customerId] });
}

module.exports = { phoneKeys, syncPhoneKeys, LOCAL_AREA_CODE };
