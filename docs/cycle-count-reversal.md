# Restoring items a cycle count wrongly set to 0

Script: `scripts/reverse-zero-uncounted.js` (in the container after any redeploy).

## When to use

A committed cycle count set items to 0 that weren't really counted, either because
**"Count the uncounted lines as 0"** was ticked, or because the imported file had `0`
against items nobody counted. The script puts those items back to where they were
before that commit. Real counts in the same session, and sales/receipts/transfers
since, are kept.

## 1. Find the session number

POS → Warehouse → Cycle Counts → note the CC number of the **bad** session (the one
that zeroed things, not the earlier good count), e.g. `CC-000004`. Replace
`CC-000004` in the commands below with that number.

## 2. Open a console in the container

Portainer → Containers → POS app container → **Console** (`>_`)
Command: `/bin/sh`, User: `root` → Connect. Then:

```sh
cd /app
```

## 3. Back up the database (every time)

```sh
su-exec app node -e "require('./database').db.execute(\"VACUUM INTO '/app/data/pos-backup-before-cc-fix.db'\").then(()=>console.log('backup ok'))"
```

Wait for `backup ok`. If a backup with that name already exists, change the file
name (e.g. `pos-backup-before-cc-fix-2.db`) or `VACUUM INTO` will fail.

## 4. Dry run, normal mode (changes nothing)

If the zero box was ticked:

```sh
su-exec app node scripts/reverse-zero-uncounted.js CC-000004
```

If the zeros came from an imported file (or you're not sure):

```sh
su-exec app node scripts/reverse-zero-uncounted.js CC-000004 --include-imported-zeros --only-previously-counted
```

Check:

- The first line says `Database: file:/app/data/pos.db`. If not, **stop**.
- **Uploads in …** shows which file(s) had the zeros.
- Each item shows Zeroed by / Restore + / Branch now→after / Earlier count.
- **From upload** column: if an item there was *genuinely* counted as 0, note its
  SKU so you can leave it out with `--exclude`.

To look at one item: `… | grep SKU123`. To see only the top: `… | head -20`.

### If the last file of a multi-file count zeroed items

`--only-previously-counted` only looks at **earlier sessions**. An item counted in
an earlier file of the *same* session, then zeroed by the last file, is left out and
stays at 0. So when one session had several uploads, run the dry run without it:

```sh
su-exec app node scripts/reverse-zero-uncounted.js CC-000004 --include-imported-zeros
```

Check that the last file's line under **Uploads in …** shows most of its lines as 0,
and that the summary line shows the right branch. If more than one committed session
zeroed items, run this for each of them. Then read each row:

| Earlier count | From upload | What it means | What to do |
|---|---|---|---|
| A number | `#3` | Counted in an earlier session, then zeroed | Restore |
| `—` | `#2,#3` | In an earlier file of this session, then zeroed; the earlier file may have had a real count | Restore, then check the quantity |
| `—` | `#3` | Only in the last file, as 0, with no earlier count | Restore only if it wasn't really counted as 0 |
| `—` | `checkbox` | Zeroed by the box; nobody counted it | Restore if it should have stock |

This list can include items that really were counted as 0, so leave those out when
you apply, using `--exclude=SKU1,SKU2`, or list only the items to restore with
`--skus=SKU1,SKU2`:

```sh
su-exec app node scripts/reverse-zero-uncounted.js CC-000004 --include-imported-zeros --exclude=SKU1,SKU2 --apply
```

A restore puts back the stock figure from before that session's count, **not** the
quantity in the earlier file. For example, an item with 10 on hand and a count of 5
in the first file goes back to 10. Where a file had a real count, adjust that item
by hand afterwards.

If items were adjusted by hand since the commit, leave `--only-previously-counted`
out of the step 6 commands too.

## 5. Apply, normal mode

Run the same command as step 4 with `--apply` on the end:

```sh
su-exec app node scripts/reverse-zero-uncounted.js CC-000004 --include-imported-zeros --only-previously-counted --apply
```

Items someone has adjusted by hand since the commit are **skipped** here and listed
at the end. Deal with them in step 6.

## 6. Items adjusted by hand since the commit

Dry run:

```sh
su-exec app node scripts/reverse-zero-uncounted.js CC-000004 --include-imported-zeros --only-previously-counted --adjusted
```

For each item it shows the on-hand before the bad count, the earlier count, every
hand adjustment since (time, qty, reason), and `now X → Y`. This mode **undoes those
hand adjustments** as well as the zeroing. That's only right if they were attempts
to fix the zeroing. If an adjustment was a real recount, leave that item out.

Apply (add `--exclude` or `--skus` as needed):

```sh
su-exec app node scripts/reverse-zero-uncounted.js CC-000004 --include-imported-zeros --only-previously-counted --adjusted --apply
```

## 7. Check

Open a few items in Inventory → History. You should see a new adjustment with
reference `CC-000004-REV` putting the stock back. No restart needed.

## Options

| Option | Meaning |
|---|---|
| `--apply` | Make the changes. Without it the run is a dry run and nothing changes. |
| `--include-imported-zeros` | Also restore zeros that came from an imported file |
| `--only-previously-counted` | Only items counted in an earlier committed session (use with `--include-imported-zeros`). Leaves out items counted only in an earlier file of the same session; see step 4 |
| `--adjusted` | Handle the items fixed by hand since (undoes those fixes too) |
| `--skus=SKU1,SKU2` | Only these items |
| `--exclude=SKU1,SKU2` | Leave these items out |

## Safety notes

- Always put `su-exec app` in front of the command, never plain `node` as root.
  Root-owned DB files can stop the POS saving.
- Always dry run first and read the list before `--apply`.
- Safe to re-run: an item already restored (it has a `CC-xxxxxx-REV` entry) is never
  restored twice.
- Don't re-upload the same count file into a new session. Its zeros would wipe the
  items again, and counted items would lose the sales made since.
- Works best soon after the mistake. Items never counted before have no earlier
  figure to restore.
- If something goes wrong, the backup is `data/pos-backup-before-cc-fix.db` in the
  stack folder on the host. Ask before restoring it, because restoring it loses
  everything entered after the backup.

## Prevention

- In a top-up or partial count, leave Counted Qty **blank** for items not counted.
  `0` means "counted, none found".
- Only tick **"Count the uncounted lines as 0"** on a full count of the whole branch.
