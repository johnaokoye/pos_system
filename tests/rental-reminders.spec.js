import { test, expect } from './fixtures.js';
import net from 'net';

// Rental reminder emails (lib/rentalReminders.js): day before, due day,
// overdue — once each per due date, only for rentals due since they were
// turned on, logged on the agreement. A throwaway SMTP server in this process
// catches the mail.
const api = (page, method, url, data) => page.evaluate(([m, u, d]) => App.api(m, u, d), [method, url, data]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function fakeSmtp() {
  const mails = [];
  const server = net.createServer(sock => {
    let data = false, buf = '', cur = null;
    sock.write('220 test ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while (true) {
        if (data) {
          i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          // Quoted-printable decoded, so phrases aren't split by soft line breaks.
          cur.body = Buffer.from(buf.slice(0, i).replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'); buf = buf.slice(i + 5); data = false;
          mails.push(cur); sock.write('250 OK\r\n');
          continue;
        }
        i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
        else if (cmd === 'MAIL') { cur = { to: [] }; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { cur.to.push(line.replace(/.*<|>.*/g, '')); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ mails, port: server.address().port, close: () => server.close() })));
}

test('customers get reminder emails before and after a rental is due, once each, with a tracking link', async ({ page }) => {
  const smtp = await fakeSmtp();
  const s = `${Date.now()}`;
  const day = n => page.evaluate(k => App._storeDay(new Date(Date.now() + k * 86400000)), n);
  const [yesterday, today, tomorrow, inTwo] = await Promise.all([-1, 0, 1, 2].map(day));
  const branch = (await api(page, 'GET', '/branches')).find(b => b.active !== 0 && !b.is_warehouse);
  const guard = await api(page, 'POST', '/employees', { first_name: 'Rem', last_name: `Guard ${s}`, username: `rg${s}`, pin: s.slice(-6), password: 'pw-123456', must_change_password: 0, security_group_id: (await api(page, 'GET', '/security-groups')).find(g => g.name === 'Manager').id, active: 1, is_security: 1 });
  const { id: batch_id } = await api(page, 'POST', '/customer-imports');
  await api(page, 'POST', '/customers/import', { batch_id, rows: [{ first_name: 'Remi', last_name: `Renter ${s}`, phone: `873${s.slice(-7)}`, email: `remi${s}@example.com`, customer_type: 'cash', is_rental_customer: '1', rental_preapproved: '1' }] });
  const customer = (await api(page, 'GET', `/customers?active=1&limit=5&search=${encodeURIComponent(`Renter ${s}`)}`))[0];
  const item = await api(page, 'POST', '/products', { sku: `REM-${s}`, name: `Reminder Saw ${s}`, is_rental: 1, rental_rate: 50, branch_id: branch.id, stock_qty: 5 });

  // An active (issued) rental due on `due`.
  async function rental(due) {
    const ag = await api(page, 'POST', '/rentals/agreements', { customer_id: customer.id, branch_id: branch.id, due_date: due, items: [{ product_id: item.id, quantity: 1 }] });
    await api(page, 'PATCH', `/rentals/agreements/${ag.id}/checkout`, { payment_method: 'cash', amount_tendered: 100000 });
    await page.evaluate(async ([id, b64]) => {
      const fd = new FormData(); fd.append('stage', 'issue');
      fd.append('photo', new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/png' }), 'out.png');
      await fetch(`/api/rentals/agreements/${id}/photos`, { method: 'POST', body: fd, headers: { 'X-Pos-User': String(App.currentUser.id) } });
    }, [ag.id, PNG.toString('base64')]);
    const sig = 'data:image/png;base64,' + PNG.toString('base64');
    await api(page, 'PATCH', `/rentals/agreements/${ag.id}/issue`, { security_employee_id: guard.id, customer_signature: sig, security_signature: sig });
    // Issuing today can't backdate the due date; set it after for the overdue case.
    return ag;
  }
  const dueTomorrow = await rental(tomorrow);
  const dueToday = await rental(today);
  const later = await rental(inTwo);
  const overdue = await rental(yesterday);

  const old = await api(page, 'GET', '/settings');
  try {
    await api(page, 'PUT', '/settings', { email_smtp_host: '127.0.0.1', email_smtp_port: String(smtp.port), email_smtp_secure: 'false', email_smtp_user: '', website_url: 'https://shop.example.com', store_name: 'Test Tools' });
    // Off by default: the half-hourly pass does nothing (checked through the switch below).
    expect((await api(page, 'GET', '/settings/website')).rental_reminders_enabled).toBe(false);
    await api(page, 'PUT', '/settings/website', { rental_reminders_enabled: true });
    const ws = await api(page, 'GET', '/settings/website');
    expect(ws).toMatchObject({ rental_reminders_enabled: true, rental_reminders_since: today });

    let r = await api(page, 'POST', '/rentals/reminders/run', {});
    const mine = list => list.filter(x => [dueTomorrow.id, dueToday.id, later.id, overdue.id].includes(x.agreement_id));
    expect(mine(r.sent).map(x => [x.agreement_id, x.kind]).sort()).toEqual([[dueTomorrow.id, 'due_soon'], [dueToday.id, 'due_today']].sort());
    const mail = smtp.mails.find(m => m.to.includes(`remi${s}@example.com`) && m.body.includes(dueTomorrow.agreement_number));
    expect(mail.body).toMatch(/due back tomorrow/);
    expect(mail.body).toContain(`https://shop.example.com/account/rentals/${dueTomorrow.id}`);
    expect(mail.body).toContain(`REM-${s}`);

    // Once each: running again sends nothing more for these.
    r = await api(page, 'POST', '/rentals/reminders/run', {});
    expect(mine(r.sent)).toEqual([]);

    // Logged on the agreement, and shown there.
    const full = await api(page, 'GET', `/rentals/agreements/${dueToday.id}`);
    expect(full.reminders).toMatchObject([{ kind: 'due_today', status: 'sent', sent_to: `remi${s}@example.com` }]);
    await page.evaluate(id => App.viewRentalAgreement(id), dueToday.id);
    await expect(page.locator('.modal')).toContainText('Due today reminder sent');
    await page.evaluate(() => App.closeModal());

    // Overdue: not reminded while it was due before reminders were turned on…
    expect(r.sent.some(x => x.agreement_id === overdue.id)).toBe(false);
    // …but it is once that day is earlier, and it says how late.
    await api(page, 'PUT', '/settings', { rental_reminders_since: yesterday });
    r = await api(page, 'POST', '/rentals/reminders/run', {});
    expect(mine(r.sent).map(x => [x.agreement_id, x.kind])).toEqual([[overdue.id, 'overdue']]);
    const late = smtp.mails.find(m => m.body.includes(overdue.agreement_number));
    expect(late.body).toMatch(/1 day overdue/);
    // The next overdue reminder waits 3 days.
    expect(mine((await api(page, 'POST', '/rentals/reminders/run', {})).sent)).toEqual([]);

    // A failed send is logged on the agreement, and not retried straight away.
    await api(page, 'PUT', '/settings', { email_smtp_host: '' });
    const failRental = await rental(tomorrow);
    r = await api(page, 'POST', '/rentals/reminders/run', {});
    expect(r.failed.filter(x => x.agreement_id === failRental.id)).toMatchObject([{ kind: 'due_soon' }]);
    expect((await api(page, 'POST', '/rentals/reminders/run', {})).failed.filter(x => x.agreement_id === failRental.id)).toEqual([]);
    expect((await api(page, 'GET', `/rentals/agreements/${failRental.id}`)).reminders).toMatchObject([{ status: 'failed' }]);
  } finally {
    await api(page, 'PUT', '/settings', { email_smtp_host: old.email_smtp_host || '', email_smtp_port: old.email_smtp_port || '', website_url: old.website_url || '', store_name: old.store_name || '', rental_reminders_since: '' });
    await api(page, 'PUT', '/settings/website', { rental_reminders_enabled: false });
    smtp.close();
  }
});
