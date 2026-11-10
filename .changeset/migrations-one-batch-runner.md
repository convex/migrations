---
"@convex-dev/migrations": patch
---

Fix `Migrations.runner()` so `oneBatchOnly: true` runs only one batch without
scheduling another batch or the next migration (#74).
