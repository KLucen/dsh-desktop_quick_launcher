# desktop-quick-launcher

A standalone DSH Web plugin (independent rebuild of the retired
`@linxin666/dsh-desktop-launcher`): a floating control in the Web UI that
creates/refreshes a double-click **desktop icon** which starts `dsh web` and
opens the GUI, and that can request a graceful **host exit**.

Host endpoints `/api/desktop-quick-launcher/create` and `/shutdown` are
loopback-only. The launcher script is written to
`<dsh-home>/desktop-quick-launcher/` with a `launcher.log` next to it.
Read `README.zh.md` for the full build / local-debug / GitHub-install guide.

License: Apache-2.0 (migrated from @linxin666/dsh-desktop-launcher).
