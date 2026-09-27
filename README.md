# yoohub-deobf (Server 1 — Web only)

หน้าเว็บ + API gateway  
**ไม่มี engine ถอดรหัส** — ส่งงานไป repo `yoohub-deobf-worker`

## Render
- Runtime: Node
- Start: `node server.js`
- Env:
  - `PUBLIC_URL` = URL เว็บนี้
  - `WORKER_URL` = URL ของ yoohub-deobf-worker
  - `SHARED_SECRET` = รหัสเดียวกับ worker
