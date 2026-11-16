# Copying snapshots to a standby server

Keeps a second Ubuntu server (Hyper-V VM running the POS in Portainer) supplied with
recent copies of the production database and uploads, a few times a day.

## How it works

- Production's own **Settings → Database Backups** makes the snapshots. Each one is a
  complete, consistent copy (`VACUUM INTO`) named `pos-YYYYMMDD-HHMMSS.db`.
- The standby **pulls** them, plus the `uploads/` folder, with `rsync` over SSH from
  cron. Production holds no login to the standby, so it can't delete the copies.
- Loading a snapshot into the standby's app is a separate step you choose to run.

**Never copy the live `pos.db` directly.** Recent writes live in `pos.db-wal` while
the app runs, so a raw copy can be missing data or corrupt. Only ship the `pos-*.db`
backup files.

## 1. Production: schedule backups

POS → Settings → Database Backups:

- Schedule: **every 2 hours** (or 1 during trading hours). Each backup briefly pauses
  the tills (about 0.4 s per 136 MB), so don't go below hourly.
- Keep: **24** or more.

On the production host the files land in `<stack folder>/data/backups/`. To find the
stack folder: Portainer → Stacks → the POS stack. Or, on the host, run
`docker inspect <app container> | grep -A1 '"Source"'` and look for the folder that
holds `data` and `uploads`.

## 2. Production: a user the standby can log in as

On the production host:

```sh
sudo adduser --disabled-password --gecos '' backupuser
# backupuser needs read access to the stack's data/backups and uploads folders:
sudo setfacl -R -m u:backupuser:rX  /path/to/prod/stack/data/backups /path/to/prod/stack/uploads
sudo setfacl -R -d -m u:backupuser:rX /path/to/prod/stack/data/backups /path/to/prod/stack/uploads
```

(`setfacl` comes from the `acl` package: `sudo apt install acl`.)

## 3. Standby: SSH key

On the standby, as the user that will run cron:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/pos_pull -N ''
ssh-copy-id -i ~/.ssh/pos_pull.pub backupuser@PROD_HOST
ssh -i ~/.ssh/pos_pull backupuser@PROD_HOST ls /path/to/prod/stack/data/backups   # should list pos-*.db
```

## 4. Standby: the pull script

Save as `/usr/local/bin/pos-pull.sh`, then edit the three settings at the top:

```bash
#!/bin/bash
set -euo pipefail
PROD=backupuser@PROD_HOST
SRC=/path/to/prod/stack          # the folder holding data/ and uploads/
DEST=/srv/pos-snapshots
KEEP=48                          # snapshots kept on the standby
SSH="ssh -i $HOME/.ssh/pos_pull -o BatchMode=yes"

mkdir -p "$DEST/db" "$DEST/uploads"
# Finished backup files only (an unfinished copy is named .partial, never pos-*.db)
rsync -a -e "$SSH" --include='pos-*.db' --exclude='*' "$PROD:$SRC/data/backups/" "$DEST/db/"
# Product images, attachments, signatures, ID scans: the database only holds their paths
rsync -a --delete -e "$SSH" "$PROD:$SRC/uploads/" "$DEST/uploads/"
# Keep the newest $KEEP snapshots
ls -1t "$DEST"/db/pos-*.db | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "$(date '+%F %T') ok: latest $(ls -1t "$DEST"/db/pos-*.db | head -1)"
```

```sh
sudo chmod +x /usr/local/bin/pos-pull.sh
sudo mkdir -p /srv/pos-snapshots && sudo chown "$USER" /srv/pos-snapshots
/usr/local/bin/pos-pull.sh        # test once by hand
```

## 5. Standby: run it from cron

`crontab -e`, then run it 10 minutes after each backup slot:

```
10 */2 * * * /usr/local/bin/pos-pull.sh >> $HOME/pos-pull.log 2>&1
```

Check `~/pos-pull.log` from time to time. Every run should end with `ok: latest …`
and a recent time.

## 6. Loading a snapshot into the standby's app

Do this only when you want the standby to match production (to test on real data,
or to take over if production fails).

**Option A: by hand.** Portainer → Stacks → the standby POS stack → **Stop**. Then on
the standby host:

```sh
cd /path/to/standby/stack
mkdir -p data/pre-load && cp -a data/pos.db* data/pre-load/ 2>/dev/null || true
rm -f data/pos.db-wal data/pos.db-shm
cp "$(ls -1t /srv/pos-snapshots/db/pos-*.db | head -1)" data/pos.db
rsync -a --delete /srv/pos-snapshots/uploads/ uploads/
```

Then start the stack again.

**Option B: from the app.** Copy the snapshot into the standby's
`data/backups/` folder, then use Settings → Database Backups → **Restore** on the
standby. The app checks the file, keeps a pre-restore copy and restarts itself. Copy
`uploads/` across as in Option A as well.

Don't automate this load step if people test on the standby: each load replaces
whatever they entered there.

## 7. Before the standby runs on production data

A restored copy carries production's settings, so the standby will run production's
background jobs. Make sure of all three every time you load a snapshot:

- **WooCommerce:** clear `woo_url` / switch off auto-sync (Settings → Integrations),
  or it will push stock and orders to the live store.
- **Email:** clear the SMTP settings, or it can email customers and suppliers.
- **RetailPOS Books:** must not point at the standby, and the standby must not post
  to Books.

The safest choice is to block outbound internet from the standby's app container
altogether, then nothing can leak even if a setting is missed.

## Alternatives considered

- **Backups' own copy folder** (`POS_BACKUP_COPY_DIR`, a share mounted on the
  production host): no cron, but it doesn't copy `uploads/`, and if the share is
  unavailable the copy fails.
- **Continuous replication (Litestream):** near-real-time copies, but more moving
  parts alongside the app's database driver. Worth looking at only if a two-hour gap
  is too much.
