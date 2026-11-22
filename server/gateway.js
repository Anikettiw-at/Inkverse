// Unified payment gateway: one order pipeline for every provider.
//
//   Razorpay  (India: UPI, cards, netbanking, wallets — INR)  RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET (+ RAZORPAY_WEBHOOK_SECRET)
//   Stripe    (international cards — USD)                       STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
//   Demo      (sandbox, no real money; on when no real gateway is configured, off with DEMO_PAYMENTS=false)
//
// Flow:  POST /api/pay/orders  -> order row (amount computed on the server, never trusted from the client)
//        -> provider checkout -> signed confirmation (Razorpay handler signature / webhook, Stripe webhook, demo confirm)
//        -> fulfil(): marks the order paid exactly once and credits coins (+ coupon bonus, + referral reward).
const crypto = require('crypto');
const express = require('express');
const { db, RULES } = require('./db');

const now = () => Date.now();
const HOUR = 3600_000;

// ---------- configuration ----------
const rzpOn = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const stripeOn = () => !!process.env.STRIPE_SECRET_KEY;
const demoOn = () => process.env.DEMO_PAYMENTS === 'true' || (process.env.DEMO_PAYMENTS !== 'false' && !rzpOn() && !stripeOn());
function enabledGateways() {
  const g = [];
  if (rzpOn()) g.push({ id: 'razorpay', label: 'UPI · Cards · Netbanking', currency: 'INR', provider: 'Razorpay' });
  if (stripeOn()) g.push({ id: 'stripe', label: 'International card', currency: 'USD', provider: 'Stripe' });
  if (demoOn()) g.push({ id: 'demo', label: 'Demo checkout (no real money)', currency: demoCurrency(), provider: 'Sandbox' });
  return g;
}
const demoCurrency = () => (process.env.DEMO_CURRENCY || 'INR').toUpperCase() === 'USD' ? 'USD' : 'INR';
function priceFor(pack, gateway) {
  const cur = gateway === 'razorpay' ? 'INR' : gateway === 'stripe' ? 'USD' : demoCurrency();
  return cur === 'INR' ? { amount: pack.paise, currency: 'INR' } : { amount: pack.cents, currency: 'USD' };
}
const fmtMoney = (amount, currency) => (currency === 'INR' ? '₹' : '$') + (amount / 100).toFixed(2);
const baseUrl = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- coupons ----------
function findCoupon(code, userId) {
  if (!code) return null;
  const c = db.prepare('SELECT * FROM coupons WHERE code=?').get(String(code).trim());
  if (!c || !c.active) throw new Error('This coupon code is not valid.');
  if (c.expires_at && c.expires_at < now()) throw new Error('This coupon has expired.');
  if (c.max_uses && c.uses >= c.max_uses) throw new Error('This coupon has been fully used.');
  if (userId && db.prepare('SELECT 1 FROM coupon_redemptions WHERE code=? AND user_id=?').get(c.code, userId)) throw new Error('You have already used this coupon.');
  return c;
}
const bonusFor = (pack, coupon) => coupon ? Math.floor(pack.coins * coupon.bonus_pct / 100) : 0;

// ---------- provider APIs (plain REST, no SDKs) ----------
async function razorpay(method, path, body) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1' + path, { method, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.description || `Razorpay error ${r.status}`);
  return data;
}
async function stripe(path, params) {
  const r = await fetch('https://api.stripe.com/v1' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `Stripe error ${r.status}`);
  return data;
}

// ---------- fulfilment: the ONLY place that turns a payment into coins ----------
// Idempotent: the conditional UPDATE lets exactly one caller (handler, webhook or retry) credit the order.
function fulfil(orderId, { paymentId, amount, currency } = {}) {
  return db.transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o) return { ok: false, reason: 'unknown order' };
    if (o.status === 'paid' || o.status === 'refunded') return { ok: true, duplicate: true, order: o };
    if (amount !== undefined && (Number(amount) !== o.amount || String(currency).toUpperCase() !== o.currency)) {
      db.prepare("UPDATE orders SET status='failed', failure=? WHERE id=?").run(`amount mismatch: got ${amount} ${currency}`, o.id);
      console.error('Payment rejected (amount mismatch):', o.id, amount, currency);
      return { ok: false, reason: 'amount mismatch' };
    }
    const upd = db.prepare("UPDATE orders SET status='paid', paid_at=?, gateway_payment_id=COALESCE(?, gateway_payment_id), failure=NULL WHERE id=? AND status IN ('created','failed')").run(now(), paymentId || null, o.id);
    if (!upd.changes) return { ok: true, duplicate: true, order: o };
    const total = o.coins + o.bonus_coins;
    db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(total, o.user_id);
    db.prepare('INSERT INTO transactions(user_id,type,coins,cents,note,created_at) VALUES(?,?,?,?,?,?)').run(o.user_id, 'purchase', total, o.currency === 'USD' ? o.amount : 0,
      `${o.gateway === 'demo' ? 'Demo' : o.gateway[0].toUpperCase() + o.gateway.slice(1)} ${fmtMoney(o.amount, o.currency)} · ${o.id}${o.bonus_coins ? ` · +${o.bonus_coins} bonus (${o.coupon})` : ''}`, now());
    db.prepare('INSERT INTO notifications(user_id,text,link,created_at) VALUES(?,?,?,?)').run(o.user_id, `Payment successful: ${total} coins added. Receipt ${o.id}.`, `#/receipt/${o.id}`, now());
    if (o.coupon) {
      db.prepare('UPDATE coupons SET uses=uses+1 WHERE code=?').run(o.coupon);
      db.prepare('INSERT OR IGNORE INTO coupon_redemptions VALUES(?,?,?)').run(o.coupon, o.user_id, o.id);
    }
    // referral: both people get a bonus after the invitee's first successful payment
    const u = db.prepare('SELECT id, username, referred_by, ref_rewarded FROM users WHERE id=?').get(o.user_id);
    if (u.referred_by && !u.ref_rewarded) {
      const b = RULES.referralBonus;
      db.prepare('UPDATE users SET ref_rewarded=1, coins=coins+? WHERE id=?').run(b, u.id);
      db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(b, u.referred_by);
      const tx = db.prepare('INSERT INTO transactions(user_id,type,coins,note,created_at) VALUES(?,?,?,?,?)');
      tx.run(u.id, 'bonus', b, 'Referral welcome bonus', now()); tx.run(u.referred_by, 'bonus', b, `Referral reward: ${u.username} joined`, now());
      db.prepare('INSERT INTO notifications(user_id,text,link,created_at) VALUES(?,?,?,?)').run(u.referred_by, `🎁 ${u.username} made their first purchase — you earned ${b} referral coins!`, '#/wallet', now());
    }
    return { ok: true, order: db.prepare('SELECT * FROM orders WHERE id=?').get(o.id) };
  })();
}
function markFailed(orderId, reason) {
  db.prepare("UPDATE orders SET status='failed', failure=? WHERE id=? AND status='created'").run(String(reason || 'failed').slice(0, 200), orderId);
}

// ---------- refunds (admin) ----------
async function refund(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || o.status !== 'paid') throw new Error('Only paid orders can be refunded.');
  if (o.gateway === 'razorpay') {
    if (!o.gateway_payment_id) throw new Error('No Razorpay payment id on this order.');
    await razorpay('POST', `/payments/${o.gateway_payment_id}/refund`, { amount: o.amount, notes: { order: o.id } });
  } else if (o.gateway === 'stripe') {
    if (!o.gateway_payment_id) throw new Error('No Stripe payment intent on this order.');
    await stripe('/refunds', { payment_intent: o.gateway_payment_id });
  }
  return db.transaction(() => {
    if (!db.prepare("UPDATE orders SET status='refunded', refunded_at=? WHERE id=? AND status='paid'").run(now(), o.id).changes) throw new Error('Order already refunded.');
    const total = o.coins + o.bonus_coins, bal = db.prepare('SELECT coins FROM users WHERE id=?').get(o.user_id).coins, take = Math.min(bal, total);
    db.prepare('UPDATE users SET coins=coins-? WHERE id=?').run(take, o.user_id);
    db.prepare('INSERT INTO transactions(user_id,type,coins,cents,note,created_at) VALUES(?,?,?,?,?,?)').run(o.user_id, 'refund', -take, o.currency === 'USD' ? -o.amount : 0,
      `Refund ${fmtMoney(o.amount, o.currency)} · ${o.id}${take < total ? ` (${total - take} coins were already spent)` : ''}`, now());
    db.prepare('INSERT INTO notifications(user_id,text,link,created_at) VALUES(?,?,?,?)').run(o.user_id, `Your payment ${o.id} (${fmtMoney(o.amount, o.currency)}) was refunded.`, `#/receipt/${o.id}`, now());
    return { coinsRemoved: take, shortfall: total - take };
  })();
}

const shapeOrder = o => o && ({ id: o.id, pack_id: o.pack_id, coins: o.coins, bonus_coins: o.bonus_coins, amount: o.amount, currency: o.currency, display: fmtMoney(o.amount, o.currency),
  gateway: o.gateway, payment_id: o.gateway_payment_id, coupon: o.coupon, status: o.status, failure: o.failure, created_at: o.created_at, paid_at: o.paid_at, refunded_at: o.refunded_at });

// ---------- webhooks (raw body; mount BEFORE express.json) ----------
function mountWebhooks(app) {
  app.post('/api/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook secret not configured.' });
    if (!safeEq(hmac(secret, req.body), String(req.headers['x-razorpay-signature'] || ''))) return res.status(400).json({ error: 'Bad signature.' });
    let ev; try { ev = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Bad payload.' }); }
    const p = ev.payload?.payment?.entity;
    const o = p?.order_id && db.prepare("SELECT id FROM orders WHERE gateway='razorpay' AND gateway_order_id=?").get(p.order_id);
    if (!o) return res.json({ received: true, ignored: true });
    if (ev.event === 'payment.captured' || ev.event === 'order.paid') fulfil(o.id, { paymentId: p.id, amount: p.amount, currency: p.currency });
    else if (ev.event === 'payment.failed') markFailed(o.id, p.error_description || 'payment failed');
    res.json({ received: true });
  });
}

// ---------- routes ----------
function mountRoutes(app, { needAuth, needRole, fail, audit }) {
  const admin = needRole('admin');

  app.get('/api/pay/gateways', (req, res) => res.json({ gateways: enabledGateways(), razorpayKey: rzpOn() ? process.env.RAZORPAY_KEY_ID : null }));

  app.post('/api/pay/coupon', needAuth, (req, res) => {
    const pack = RULES.coinPacks.find(p => p.id === req.body.pack);
    try { const c = findCoupon(req.body.code, req.user.id); if (!c) return fail(res, 400, 'Enter a coupon code.');
      res.json({ code: c.code, bonus_pct: c.bonus_pct, bonus_coins: pack ? bonusFor(pack, c) : null }); }
    catch (e) { fail(res, 400, e.message); }
  });

  app.post('/api/pay/orders', needAuth, async (req, res) => {
    const pack = RULES.coinPacks.find(p => p.id === req.body.pack); if (!pack) return fail(res, 400, 'Unknown pack.');
    const gateway = String(req.body.gateway || enabledGateways()[0]?.id || '');
    if (!enabledGateways().some(g => g.id === gateway)) return fail(res, 400, 'That payment method is not available.');
    if (db.prepare("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='created' AND created_at>?").get(req.user.id, now() - HOUR).n >= 10)
      return fail(res, 429, 'Too many unfinished checkouts. Please wait a bit and try again.');
    let coupon; try { coupon = findCoupon(req.body.coupon, req.user.id); } catch (e) { return fail(res, 400, e.message); }
    const { amount, currency } = priceFor(pack, gateway);
    const o = { id: 'ord_' + crypto.randomBytes(9).toString('base64url'), user_id: req.user.id, pack_id: pack.id, coins: pack.coins, bonus_coins: bonusFor(pack, coupon), amount, currency, gateway, coupon: coupon?.code || null };
    db.prepare('INSERT INTO orders(id,user_id,pack_id,coins,bonus_coins,amount,currency,gateway,coupon,created_at) VALUES(@id,@user_id,@pack_id,@coins,@bonus_coins,@amount,@currency,@gateway,@coupon,@now)').run({ ...o, now: now() });
    const desc = `${o.coins}${o.bonus_coins ? ` + ${o.bonus_coins} bonus` : ''} InkVerse coins`;
    try {
      if (gateway === 'razorpay') {
        const r = await razorpay('POST', '/orders', { amount, currency, receipt: o.id, notes: { order: o.id, user: String(req.user.id), pack: pack.id } });
        db.prepare('UPDATE orders SET gateway_order_id=? WHERE id=?').run(r.id, o.id);
        return res.json({ order: shapeOrder({ ...o, status: 'created' }), razorpay: { key: process.env.RAZORPAY_KEY_ID, order_id: r.id, amount, currency, name: 'InkVerse', description: desc, prefill: { name: req.user.username, email: req.user.email } } });
      }
      if (gateway === 'stripe') {
        const base = baseUrl(req);
        const s = await stripe('/checkout/sessions', { mode: 'payment', client_reference_id: String(req.user.id), customer_email: req.user.email,
          success_url: `${base}/#/receipt/${o.id}?paid=1`, cancel_url: `${base}/#/wallet?cancelled=${o.id}`, 'metadata[order]': o.id, 'metadata[pack]': pack.id,
          'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(amount), 'line_items[0][price_data][product_data][name]': desc });
        db.prepare('UPDATE orders SET gateway_order_id=? WHERE id=?').run(s.id, o.id);
        return res.json({ order: shapeOrder({ ...o, status: 'created' }), url: s.url });
      }
      res.json({ order: shapeOrder({ ...o, status: 'created' }), demo: true });
    } catch (e) {
      markFailed(o.id, e.message); console.error(`${gateway} order error:`, e.message);
      fail(res, 502, 'Could not start the payment. Please try again.');
    }
  });

  // Razorpay Checkout success handler: signature = HMAC_SHA256(order_id|payment_id, key_secret)
  app.post('/api/pay/razorpay/verify', needAuth, async (req, res) => {
    if (!rzpOn()) return fail(res, 400, 'Razorpay is not enabled.');
    const o = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=? AND gateway='razorpay'").get(String(req.body.order_id), req.user.id);
    if (!o) return fail(res, 404, 'Order not found.');
    const { razorpay_order_id: rid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body;
    if (rid !== o.gateway_order_id || !safeEq(hmac(process.env.RAZORPAY_KEY_SECRET, `${rid}|${pid}`), String(sig || ''))) return fail(res, 400, 'Payment verification failed.');
    // Signature proves the payment belongs to this order; still confirm amount with Razorpay before crediting.
    let amount, currency;
    try { const p = await razorpay('GET', `/payments/${encodeURIComponent(pid)}`); if (!['captured', 'authorized'].includes(p.status)) return fail(res, 402, 'Payment not completed yet.'); amount = p.amount; currency = p.currency; }
    catch (e) { console.error('Razorpay fetch payment:', e.message); return fail(res, 502, 'Could not confirm payment — if money was taken it will be credited automatically.'); }
    const r = fulfil(o.id, { paymentId: pid, amount, currency });
    if (!r.ok) return fail(res, 400, 'Payment could not be verified.');
    res.json({ ok: true, order: shapeOrder(r.order), coins: db.prepare('SELECT coins FROM users WHERE id=?').get(req.user.id).coins });
  });

  // Demo sandbox: lets you exercise success AND failure paths end-to-end without a provider.
  app.post('/api/pay/demo/confirm', needAuth, (req, res) => {
    if (!demoOn()) return fail(res, 403, 'Demo checkout is disabled.');
    const o = db.prepare("SELECT * FROM orders WHERE id=? AND user_id=? AND gateway='demo'").get(String(req.body.order_id), req.user.id);
    if (!o) return fail(res, 404, 'Order not found.');
    if (req.body.outcome === 'fail') { markFailed(o.id, 'Declined in demo checkout'); return fail(res, 402, 'Payment declined (demo).'); }
    const r = fulfil(o.id, { paymentId: 'demo_' + crypto.randomBytes(6).toString('hex') });
    res.json({ ok: true, order: shapeOrder(r.order), coins: db.prepare('SELECT coins FROM users WHERE id=?').get(req.user.id).coins });
  });

  app.post('/api/pay/orders/:id/cancel', needAuth, (req, res) => {
    const o = db.prepare('SELECT id FROM orders WHERE id=? AND user_id=?').get(req.params.id, req.user.id); if (!o) return fail(res, 404, 'Order not found.');
    markFailed(o.id, String(req.body.reason || 'Checkout closed').slice(0, 120)); res.json({ ok: true });
  });
  app.get('/api/pay/orders', needAuth, (req, res) => res.json(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id).map(shapeOrder)));
  app.get('/api/pay/orders/:id', needAuth, (req, res) => {
    const o = db.prepare('SELECT o.*, u.username, u.email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?').get(req.params.id);
    if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) return fail(res, 404, 'Order not found.');
    res.json({ ...shapeOrder(o), username: o.username, email: o.email, seller: process.env.BUSINESS_NAME || 'InkVerse', sellerAddress: process.env.BUSINESS_ADDRESS || '', gstin: process.env.BUSINESS_GSTIN || '' });
  });

  // ---- admin: orders, revenue, refunds, coupons
  app.get('/api/admin/orders', admin, (req, res) => {
    const st = ['created', 'paid', 'failed', 'refunded'].includes(req.query.status) ? req.query.status : null;
    const sql = `SELECT o.*, u.username FROM orders o JOIN users u ON u.id=o.user_id ${st ? 'WHERE o.status=?' : ''} ORDER BY o.created_at DESC LIMIT 100`;
    res.json((st ? db.prepare(sql).all(st) : db.prepare(sql).all()).map(o => ({ ...shapeOrder(o), username: o.username })));
  });
  app.get('/api/admin/revenue', admin, (req, res) => {
    const since = now() - 30 * 24 * HOUR;
    const totals = db.prepare("SELECT currency, status, COUNT(*) n, SUM(amount) amount FROM orders GROUP BY currency, status").all();
    const byGateway = db.prepare("SELECT gateway, currency, COUNT(*) n, SUM(amount) amount FROM orders WHERE status='paid' GROUP BY gateway, currency").all();
    const daily = db.prepare("SELECT strftime('%Y-%m-%d', paid_at/1000, 'unixepoch') day, currency, SUM(amount) amount, COUNT(*) n FROM orders WHERE status='paid' AND paid_at>? GROUP BY day, currency").all(since);
    const attempts = db.prepare('SELECT COUNT(*) n, SUM(status IN (\'paid\',\'refunded\')) ok FROM orders WHERE created_at>?').get(since);
    res.json({ totals, byGateway, daily, conversion: attempts.n ? Math.round(100 * attempts.ok / attempts.n) : null, attempts: attempts.n });
  });
  app.post('/api/admin/orders/:id/refund', admin, async (req, res) => {
    try { const r = await refund(req.params.id); audit(req, 'order_refund', req.params.id); res.json({ ok: true, ...r }); }
    catch (e) { fail(res, 400, e.message); }
  });
  app.get('/api/admin/coupons', admin, (req, res) => res.json(db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all()));
  app.post('/api/admin/coupons', admin, (req, res) => {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (req.body.toggle) { const c = db.prepare('UPDATE coupons SET active=1-active WHERE code=?').run(code); if (!c.changes) return fail(res, 404, 'No such coupon.'); audit(req, 'coupon_toggle', code); return res.json({ ok: true }); }
    const pct = parseInt(req.body.bonus_pct, 10), max = parseInt(req.body.max_uses || 0, 10), days = parseInt(req.body.days || 0, 10);
    if (!/^[A-Z0-9]{3,20}$/.test(code)) return fail(res, 400, 'Code: 3-20 letters/numbers.');
    if (!(pct >= 1 && pct <= 100)) return fail(res, 400, 'Bonus must be 1-100%.');
    if (!(max >= 0) || !(days >= 0)) return fail(res, 400, 'Limits must be 0 or more.');
    if (db.prepare('SELECT 1 FROM coupons WHERE code=?').get(code)) return fail(res, 409, 'That code already exists.');
    db.prepare('INSERT INTO coupons(code,bonus_pct,max_uses,expires_at,created_at) VALUES(?,?,?,?,?)').run(code, pct, max, days ? now() + days * 24 * HOUR : null, now());
    audit(req, 'coupon_create', `${code} +${pct}%`); res.json({ ok: true });
  });

  // stale checkouts the user never finished -> failed (a late webhook can still credit them)
  const expire = () => db.prepare("UPDATE orders SET status='failed', failure='Checkout expired' WHERE status='created' AND created_at<?").run(now() - 2 * HOUR);
  expire(); setInterval(expire, 10 * 60_000).unref();
}

module.exports = { mountWebhooks, mountRoutes, fulfil, refund, enabledGateways, demoOn, rzpOn, fmtMoney };
