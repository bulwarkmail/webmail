# Password-protected account archive

This feature imports all saved **basic-auth** mail accounts using one archive
password after signing in to the archive owner's mailbox, including on a browser
with empty local storage. It is an explicit
save/restore snapshot; it does not synchronize mail or automatically merge edits.

## Enable and use

Set `SETTINGS_SYNC_ENABLED=true`, configure `SESSION_SECRET`, and persist
`SETTINGS_DATA_DIR` on a writable volume, for example `/data/settings`.
If admin settings override the environment, enable settings sync there as well.
The archive is unavailable under the OAuth-only policy. Serve webmail and JMAP
over HTTPS.

1. Add the basic-auth accounts on the original browser. To include their passwords,
   connect every account first; a metadata-only archive can include disconnected accounts.
2. In **Settings → Account → Saved accounts**, select the archive owner. Use the
   same owner on other devices; changing the default mailbox does not move an archive.
3. Choose **Manage saved accounts**, enter and confirm a separate strong archive
   passphrase (at least 10 characters), choose whether to **Include mailbox passwords
   when saving**, then **Save current accounts**. The archive is encrypted even
   when mailbox passwords are excluded.
4. On a new browser, sign in normally to the owner's mailbox on the same mail
   server. If its archive exists, a popup offers to import it into this browser.
   Choose **Import accounts**, then enter the archive password. Choose whether to
   **Import mailbox passwords too**. With that option off, only the account list
   is imported; missing passwords in an archive have the same behavior.
   The offer does not appear for accounts without an archive. It is not shown
   again in this browser after importing or choosing **Not now**; manual import
   remains available in **Settings → Account → Saved accounts → Rescan for account
   archive**. Each rescan fetches the current archive for the selected owner,
   regardless of a previous dismissal/import.
5. Accounts with imported passwords are connected in a single import. Accounts
   imported without passwords remain visible for manual sign-in; existing live
   sessions and their cookies are preserved. Failed
   accounts remain visible for sign-in; the others remain usable. The optional
   “Keep accounts signed in” checkbox creates the existing per-browser session
   cookies. Without it, unlock again after a reload.

Save again after adding/removing accounts or changing mailbox passwords. Saving
replaces the archived list with the browser's current basic-auth accounts. All
must be connected when including mailbox passwords. OAuth/SSO tokens are excluded. Logout does not write or
delete the server archive. Multiple independent archives may have different owners.

A browser must have restored or saved the current archive revision before it can
replace it. Concurrent writes are rejected. When a conflict is reported, reopen
the dialog, restore the current archive and review the local account list before
saving. Restoring adds/reconnects archived accounts and preserves other local
accounts; there is no implicit cross-device deletion or background synchronization.

## Storage and security boundaries

The browser uses Web Crypto PBKDF2-HMAC-SHA-256 (600,000 iterations, random 16-byte
salt) and AES-256-GCM (random 12-byte IV). Archive version and owner identity are
authenticated alongside the encrypted contents. The password/key is never sent
to the archive endpoint or stored in local/session storage. Only account metadata,
the import prompt choice and the last known archive revision enter local storage.

The server stores one size-bounded encrypted envelope per owner under
`SETTINGS_DATA_DIR/account-vaults/<owner-hash>.json`. It has no archive decryption
key. **Ciphertext downloads intentionally work before mail authentication** so
restoration needs only the archive password. Knowing a username/server pair can
therefore reveal that an archive exists and permit downloading its ciphertext.
Use a strong, unique passphrase: copied ciphertext permits offline password guesses.
An installation's existing access controls (for example an access proxy) still apply.

Archive writes require a matching owner session and a fresh JMAP credential check;
the endpoint never relies solely on the existence of a session cookie. Body size
is checked while streaming, and storage accepts only the encrypted envelope fields.
An atomic file replacement and file lock protect the revision comparison.

After unlocking, mail credentials go through the existing JMAP login/session
mechanisms; the application backend can process them when issuing session cookies.
Browser-side encryption protects the stored archive, not a compromised running
webmail application or browser. Forgotten archive passwords cannot be recovered.
To reset, an administrator can remove that owner's archive and the user can recreate
it after signing in to the mailboxes individually. Back up the encrypted files.

File permissions are `0600` and the archive directory is created as `0700`.
After a process crash during a write, an orphan `.lock` file may require removal
by an administrator **with all writers stopped**. Do not remove live lock files.

Cryptographic references: [Web Crypto key derivation](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey),
[OWASP PBKDF2 work factor](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Separate HTTP/2 change

Protocol detection now includes the initial document's navigation timing, in
addition to resource timings. A page already negotiated over HTTP/2 or HTTP/3 can
therefore restore more than five accounts before subresources load. The hard
cookie-slot maximum remains 50; unknown/HTTP/1 connections retain the five-account
cap. This does not force HTTP/2 or change reverse-proxy settings. Verify the actual
JMAP/SSE origin supports HTTP/2 as well as the webmail origin.
