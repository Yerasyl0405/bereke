const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KASPI_WEBHOOK_SECRET = process.env.KASPI_WEBHOOK_SECRET || "";
if (!ADMIN_PASSWORD) { console.error("Задайте переменную ADMIN_PASSWORD"); process.exit(1); }

const db = new Database(process.env.DB_FILE || "shop.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, emoji TEXT, name TEXT NOT NULL, category TEXT, price INTEGER NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, token TEXT, created_at INTEGER, status TEXT, name TEXT, phone TEXT, addr TEXT, time TEXT, note TEXT, items TEXT, sub INTEGER, delivery INTEGER, total INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);
if (!db.prepare("SELECT COUNT(*) c FROM products").get().c) {
  const ins = db.prepare("INSERT INTO products(emoji,name,category,price) VALUES(?,?,?,?)");
  [["🍎","Яблоки «Алматинский апорт»","Яблоки и груши",900],["🍐","Груши","Яблоки и груши",1100],["🍌","Бананы","Экзотика",850],
   ["🍊","Апельсины","Цитрусовые",1000],["🍋","Лимоны","Цитрусовые",1300],["🍓","Клубника","Ягоды",3500],
   ["🍇","Виноград","Ягоды",1800],["🍉","Арбуз","Бахча",400],["🍈","Дыня","Бахча",700],
   ["🍑","Персики","Косточковые",1600],["🍒","Вишня","Косточковые",3000],["🥭","Манго","Экзотика",2800]]
   .forEach(r => ins.run(...r));
}

try { db.exec("ALTER TABLE products ADD COLUMN image TEXT"); } catch (e) {}
const fs = require("fs");
const UP = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(UP, { recursive: true });
const DEFAULTS = { kaspiPhone: "87754998904", kaspiLink: "", freeFrom: "10000", deliveryFee: "1000", minOrder: "3000" };
const getSettings = () => {
  const s = { ...DEFAULTS };
  db.prepare("SELECT key,value FROM settings").all().forEach(r => s[r.key] = r.value);
  return { kaspiPhone: s.kaspiPhone, kaspiLink: s.kaspiLink, freeFrom: +s.freeFrom, deliveryFee: +s.deliveryFee, minOrder: +s.minOrder };
};
const STATUSES = ["pending", "reported", "paid", "delivering", "done", "cancelled"];

const safeEq = (a, b) => {
  const h = x => crypto.createHash("sha256").update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};
const adminAuth = (req, res, next) => {
  const [scheme, b64] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && b64) {
    const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
    if (safeEq(pass, ADMIN_PASSWORD)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Admin"').status(401).send("Нужен пароль администратора");
};
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return res.status(429).json({ error: "Слишком много запросов, попробуйте позже" });
  a.push(now); hits.set(k, a); next();
};

const app = express();
app.set("trust proxy", 1);
app.post("/api/admin/products/:id/image", adminAuth, express.json({ limit: "4mb" }), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id=?").get(+req.params.id); if (!p) return res.sendStatus(404);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.data || ""));
  if (!m) return res.status(400).json({ error: "Нужен JPEG" });
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 2.5e6 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: "Неверное изображение" });
  const file = `p${p.id}-${Date.now()}.jpg`;
  fs.writeFileSync(path.join(UP, file), buf);
  if (p.image) fs.rm(path.join(UP, path.basename(p.image)), () => {});
  db.prepare("UPDATE products SET image=? WHERE id=?").run("/uploads/" + file, p.id);
  res.json({ ok: true });
});
app.use("/uploads", express.static(UP, { maxAge: "7d" }));
app.use(express.json({ limit: "50kb" }));
app.use(["/admin", "/admin.html", "/api/admin"], adminAuth);
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Публичное API ---------- */
app.get("/api/products", (req, res) =>
  res.json(db.prepare("SELECT id,emoji,name,category,price,image FROM products WHERE active=1 ORDER BY id").all()));
app.get("/api/settings", (req, res) => res.json(getSettings()));

app.post("/api/orders", limit(10, 60000), (req, res) => {
  const b = req.body || {}, s = getSettings();
  const name = String(b.name || "").trim().slice(0, 100), phone = String(b.phone || "").trim().slice(0, 30);
  const addr = String(b.addr || "").trim().slice(0, 250);
  if (name.length < 2) return res.status(400).json({ error: "Укажите имя" });
  if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Укажите телефон полностью" });
  if (addr.length < 5) return res.status(400).json({ error: "Укажите адрес доставки" });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return res.status(400).json({ error: "Корзина пуста" });
  const get = db.prepare("SELECT * FROM products WHERE id=? AND active=1");
  const items = []; let sub = 0;
  for (const it of b.items) {
    const p = get.get(+it.id), q = +it.q;
    if (!p || !(q > 0 && q <= 50) || Math.abs(q * 2 - Math.round(q * 2)) > 1e-9)
      return res.status(400).json({ error: "Неверный товар или количество" });
    items.push({ id: p.id, n: p.name, q, p: p.price }); sub += Math.round(p.price * q);
  }
  if (sub < s.minOrder) return res.status(400).json({ error: `Минимальный заказ — ${s.minOrder} ₸` });
  const delivery = sub >= s.freeFrom ? 0 : s.deliveryFee, total = sub + delivery;
  const token = crypto.randomBytes(16).toString("hex");
  const r = db.prepare(`INSERT INTO orders(token,created_at,status,name,phone,addr,time,note,items,sub,delivery,total)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(token, Date.now(), "pending", name, phone, addr,
    String(b.time || "").slice(0, 100), String(b.note || "").slice(0, 500), JSON.stringify(items), sub, delivery, total);
  res.json({ id: r.lastInsertRowid, token, total, delivery, kaspiLink: s.kaspiLink });
});

const ownOrder = (req) => {
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(+req.params.id);
  const t = String(req.query.token || req.body?.token || "");
  return o && t.length === 32 && safeEq(t, o.token) ? o : null;
};
app.get("/api/orders/:id", (req, res) => {
  const o = ownOrder(req); if (!o) return res.sendStatus(404);
  res.json({ status: o.status, total: o.total });
});
// клиент нажал «Я оплатил(а)» (ручной режим)
app.post("/api/orders/:id/reported", limit(10, 60000), (req, res) => {
  const o = ownOrder(req); if (!o) return res.sendStatus(404);
  if (o.status === "pending") db.prepare("UPDATE orders SET status='reported' WHERE id=?").run(o.id);
  res.json({ ok: true });
});

/* ---------- Уведомление об оплате ----------
   ЗАГОТОВКА. Формат запроса от Kaspi нужно сверить с документацией,
   которую вы получите при подключении Kaspi Public QR API, и поправить поля ниже. */
app.post("/api/kaspi/callback", (req, res) => {
  if (!KASPI_WEBHOOK_SECRET || !safeEq(req.get("x-webhook-secret") || "", KASPI_WEBHOOK_SECRET)) return res.sendStatus(401);
  const { orderId, amount } = req.body || {};
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(+orderId);
  if (!o) return res.sendStatus(404);
  if (+amount !== o.total) return res.status(400).json({ error: "Сумма не совпадает" });
  if (["pending", "reported"].includes(o.status)) db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(o.id);
  res.json({ ok: true });
});

/* ---------- Админ-API ---------- */
app.get("/api/admin/orders", (req, res) =>
  res.json(db.prepare("SELECT id,created_at,status,name,phone,addr,time,note,items,delivery,total FROM orders ORDER BY id DESC LIMIT 300")
    .all().map(o => ({ ...o, items: JSON.parse(o.items) }))));
app.patch("/api/admin/orders/:id", (req, res) => {
  if (!STATUSES.includes(req.body?.status)) return res.status(400).json({ error: "Неверный статус" });
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(req.body.status, +req.params.id); res.json({ ok: true });
});
app.delete("/api/admin/orders/:id", (req, res) => { db.prepare("DELETE FROM orders WHERE id=?").run(+req.params.id); res.json({ ok: true }); });

app.get("/api/admin/products", (req, res) => res.json(db.prepare("SELECT * FROM products ORDER BY id").all()));
app.post("/api/admin/products", (req, res) => {
  const { emoji, name, category, price } = req.body || {};
  if (!String(name || "").trim() || !(+price > 0)) return res.status(400).json({ error: "Укажите название и цену" });
  const r = db.prepare("INSERT INTO products(emoji,name,category,price) VALUES(?,?,?,?)")
    .run(String(emoji || "🍏").slice(0, 8), String(name).trim().slice(0, 100), String(category || "Другое").slice(0, 50), Math.round(+price));
  res.json({ id: r.lastInsertRowid });
});
app.patch("/api/admin/products/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id=?").get(+req.params.id); if (!p) return res.sendStatus(404);
  const price = req.body.price !== undefined ? Math.round(+req.body.price) : p.price;
  if (!(price > 0)) return res.status(400).json({ error: "Неверная цена" });
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : p.active;
  db.prepare("UPDATE products SET price=?, active=? WHERE id=?").run(price, active, p.id); res.json({ ok: true });
});
app.delete("/api/admin/products/:id", (req, res) => { db.prepare("DELETE FROM products WHERE id=?").run(+req.params.id); res.json({ ok: true }); });

app.get("/api/admin/settings", (req, res) => res.json(getSettings()));
app.put("/api/admin/settings", (req, res) => {
  const up = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const k of Object.keys(DEFAULTS)) if (req.body[k] !== undefined) up.run(k, String(req.body[k]).trim().slice(0, 500));
  res.json({ ok: true });
});

app.listen(PORT, () => console.log("Магазин запущен на порту " + PORT));
