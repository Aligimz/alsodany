// سجل نقاط القطاعات الأمنية — خادم Express
// التخزين: PostgreSQL إذا وُجد DATABASE_URL، وإلا ملف JSON محلي (للتجربة فقط).
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

const SECTORS = ["interior", "nsa", "ct", "intel", "defense", "bgdops", "sf", "rapid"];
const KINDS = ["scenario", "visit", "case", "bonus", "penalty"];
const FIXED = { scenario: 10, visit: 30, case: 10 };

const newId = () => crypto.randomBytes(9).toString("base64url");
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// أسبوع العراق: السبت إلى الجمعة
function weekOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  const back = (x.getUTCDay() + 1) % 7;
  x.setUTCDate(x.getUTCDate() - back);
  return x.toISOString().slice(0, 10);
}

// ---------------- storage ----------------
function makeFileStore() {
  const dir = process.env.DATA_DIR || path.join(__dirname, "data");
  const file = path.join(dir, "data.json");
  fs.mkdirSync(dir, { recursive: true });
  let state = { entries: [], reports: [] };
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  return {
    kind: "file",
    async init() {},
    async week(w) {
      return {
        entries: state.entries.filter((e) => e.week === w),
        reports: state.reports.filter((r) => r.week === w),
      };
    },
    async addEntries(list) { state.entries.push(...list); save(); },
    async deleteEntry(id) { state.entries = state.entries.filter((e) => e.id !== id); save(); },
    async addReport(r) { state.reports.push(r); save(); },
    async deleteReport(id) {
      state.entries = state.entries.filter((e) => e.reportId !== id);
      state.reports = state.reports.filter((r) => r.id !== id);
      save();
    },
  };
}

function makePgStore() {
  const { Pool } = require("pg");
  const host = (() => { try { return new URL(DATABASE_URL).hostname; } catch { return ""; } })();
  // عناوين Render الداخلية بدون نقطة (dpg-xxxx-a) ولا تحتاج SSL؛ الخارجية تحتاجه
  const needSsl = process.env.PGSSL === "false" ? false : host.includes(".") && host !== "localhost" && host !== "127.0.0.1";
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: needSsl ? { rejectUnauthorized: false } : false });
  const toEntry = (r) => ({
    id: r.id, week: r.week, day: r.day, sector: r.sector, kind: r.kind, points: r.points,
    note: r.note, status: r.status, reasons: r.reasons || undefined, reportId: r.report_id || undefined,
    createdAt: Number(r.created_at),
  });
  const toReport = (r) => ({ id: r.id, week: r.week, day: r.day, name: r.name, rows: r.rows, createdAt: Number(r.created_at) });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY, week TEXT NOT NULL, day TEXT NOT NULL, name TEXT NOT NULL,
          rows JSONB NOT NULL, created_at BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY, week TEXT NOT NULL, day TEXT NOT NULL, sector TEXT NOT NULL,
          kind TEXT NOT NULL, points INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL, reasons JSONB, report_id TEXT, created_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS entries_week ON entries(week);
        CREATE INDEX IF NOT EXISTS reports_week ON reports(week);`);
    },
    async week(w) {
      const [e, r] = await Promise.all([
        pool.query("SELECT * FROM entries WHERE week=$1 ORDER BY created_at", [w]),
        pool.query("SELECT * FROM reports WHERE week=$1 ORDER BY created_at", [w]),
      ]);
      return { entries: e.rows.map(toEntry), reports: r.rows.map(toReport) };
    },
    async addEntries(list) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const e of list) {
          await c.query(
            `INSERT INTO entries(id,week,day,sector,kind,points,note,status,reasons,report_id,created_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [e.id, e.week, e.day, e.sector, e.kind, e.points, e.note, e.status,
             e.reasons ? JSON.stringify(e.reasons) : null, e.reportId || null, e.createdAt]);
        }
        await c.query("COMMIT");
      } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
    },
    async deleteEntry(id) { await pool.query("DELETE FROM entries WHERE id=$1", [id]); },
    async addReport(r) {
      await pool.query("INSERT INTO reports(id,week,day,name,rows,created_at) VALUES($1,$2,$3,$4,$5,$6)",
        [r.id, r.week, r.day, r.name, JSON.stringify(r.rows), r.createdAt]);
    },
    async deleteReport(id) {
      await pool.query("DELETE FROM entries WHERE report_id=$1", [id]);
      await pool.query("DELETE FROM reports WHERE id=$1", [id]);
    },
  };
}

const store = DATABASE_URL ? makePgStore() : makeFileStore();

// ---------------- app ----------------
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const given = String(req.get("x-admin-password") || "");
  const a = Buffer.from(given), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: "كلمة المرور غير صحيحة" });
}
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: "خطأ في الخادم" });
});

app.get("/api/config", (req, res) => res.json({ locked: !!ADMIN_PASSWORD, storage: store.kind }));
app.post("/api/login", requireAdmin, (req, res) => res.json({ ok: true }));

app.get("/api/week/:week", wrap(async (req, res) => {
  if (!isDate(req.params.week)) return res.status(400).json({ error: "أسبوع غير صالح" });
  res.json(await store.week(req.params.week));
}));

app.post("/api/entries", requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (!SECTORS.includes(b.sector) || !KINDS.includes(b.kind) || !isDate(b.day))
    return res.status(400).json({ error: "بيانات ناقصة" });
  let points = Math.round(Number(b.points) || 0);
  if (FIXED[b.kind] !== undefined) points = FIXED[b.kind];
  if (b.kind === "penalty") points = -Math.abs(points);
  if (b.kind === "bonus") points = Math.abs(points);
  const reasons = Array.isArray(b.reasons) ? b.reasons.map(String).slice(0, 10) : null;
  const rejected = b.kind === "case" && reasons && reasons.length > 0;
  const e = {
    id: newId(), day: b.day, week: weekOf(b.day), sector: b.sector, kind: b.kind,
    points: rejected ? 0 : points, note: String(b.note || "").slice(0, 300),
    status: rejected ? "rejected" : "accepted", reasons: rejected ? reasons : undefined,
    createdAt: Date.now(),
  };
  await store.addEntries([e]);
  res.status(201).json(e);
}));

app.delete("/api/entries/:id", requireAdmin, wrap(async (req, res) => {
  await store.deleteEntry(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/reports", requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 200);
  if (!name || !isDate(b.day) || !Array.isArray(b.rows)) return res.status(400).json({ error: "بيانات ناقصة" });
  // التقرير لازم يشمل كل القطاعات
  const rows = SECTORS.map((s) => {
    const r = b.rows.find((x) => x && x.sector === s);
    return r ? { sector: s, present: !!r.present, count: r.present ? Math.max(0, Math.round(Number(r.count) || 0)) : 0,
                 completed: !!r.present && !!r.completed } : null;
  });
  if (rows.some((r) => !r)) return res.status(400).json({ error: "التقرير لازم يشمل كل القطاعات" });
  if (!b.photoAllSectors || !b.published) return res.status(400).json({ error: "لازم الصورة تضم كل القطاعات ومنشورة بالإنجازات" });
  const now = Date.now();
  const rep = { id: newId(), day: b.day, week: weekOf(b.day), name, rows, createdAt: now };
  await store.addReport(rep);
  const earned = rows.filter((r) => r.present && r.completed).map((r, i) => ({
    id: newId(), day: rep.day, week: rep.week, sector: r.sector, kind: "scenario", points: 10,
    note: "تقرير الأمن الوطني: " + name, status: "accepted", reportId: rep.id, createdAt: now + i,
  }));
  await store.addEntries(earned);
  res.status(201).json(rep);
}));

app.delete("/api/reports/:id", requireAdmin, wrap(async (req, res) => {
  await store.deleteReport(req.params.id);
  res.json({ ok: true });
}));

store.init().then(() => {
  app.listen(PORT, () => console.log(`Sector points on :${PORT} (storage: ${store.kind})`));
}).catch((err) => { console.error("DB init failed", err); process.exit(1); });
