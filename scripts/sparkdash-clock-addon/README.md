# sparkDash clock-cap add-on

**Not core sparkDash.** Core stays read-only collectors. This package is the
privileged actuator: CPU/GPU clock caps from the device page.

## Arming (all three required)

1. Install this helper **on the Spark host** (once).
2. Sudoers drop-in present (`/etc/sudoers.d/sparkdash-clock`).
3. Edit Spark → **Allow clock control** (`clockControlEnabled`, default off).

Missing any of those: Clock Cap rows stay read-only, API 403, no slider.

```bash
# On the Spark, as a sudo-capable user:
sudo ./scripts/sparkdash-clock-addon/install-clock-helper.sh
```

## Privilege facts

`NOPASSWD: /usr/local/bin/sparkdash-set-clock` with **no argv list** means
sudo allows **that binary with any arguments**. It is not “argumentless only.”
The helper itself still accepts only `--domain` / `--max-mhz` / `--unlock` /
`--persist` | `--no-persist`.

Live apply is the default UI action. **Save (survive reboot)** writes
`cpu-clock-cap.service` / `gpu-clock-lock.service` — a second, labeled step.

Revoke: delete `/etc/sudoers.d/sparkdash-clock` and/or the helper binary,
and turn the Edit Spark flag off.
