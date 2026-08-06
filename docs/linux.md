# Linux Notes

- Browser engine now works on Linux (Chrome/Chromium/Edge) without the old `DISPLAY` guard. Oracle will launch whatever `chrome-launcher` finds or what you pass via `CHROME_PATH`.
- Cookie sync supports snap-installed Chromium automatically. Common cookie DB for the Default profile:
  - `~/snap/chromium/common/chromium/Default/Cookies`
- If you use a non-default profile or a custom install, point Oracle at the correct paths:
  - `--browser-chrome-path /path/to/chrome`
  - `--browser-cookie-path /path/to/profile/Default/Cookies`
- Browser runs are headful (Cloudflare blocks headless). Keep a compositor/virtual display running if you don’t have a desktop session.
- If cookie sync still can’t find your DB, rerun with `--browser-allow-cookie-errors --browser-no-cookie-sync` and sign in manually, or dump the session cookies with `--browser-inline-cookies-file`.

## Browser profile and Oracle home storage

Oracle binds browser startup, recovery, and cleanup to a physical directory generation rather than trusting a pathname. Linux filesystems that expose a stable birth time use device, inode, and birth time directly. When birth time is unavailable, Oracle creates an owner-private `.oracle-profile-generation` file and binds the directory identity to its stable device, inode, ctime, and random generation token.

The profile directory and `ORACLE_HOME_DIR` must therefore provide stable nonzero inode and ctime metadata, atomic exclusive regular-file creation, durable directory sync, and access to descriptor paths through `/proc/self/fd`. The generation marker must remain owned by the directory owner with no group or other permissions. Filesystems that cannot provide those guarantees fail closed with a relocation error; move `ORACLE_HOME_DIR` and `ORACLE_BROWSER_PROFILE_DIR` to compatible storage. Destructive cleanup additionally requires a nonzero stable device id so Oracle can prove it will not cross a mount boundary.
