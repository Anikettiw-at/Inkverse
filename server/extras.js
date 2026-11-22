// v3 extras: coin gifts, referral program, creator earnings CSV export, reading-time / word counts.
const crypto = require('crypto');
const { db, RULES } = require('./db');
const now = () => Date.now();

function refCodeFor(userId) {
  const u = db.prepare('SELECT ref_code FROM users WHERE id=?').get(userId);
  if (u?.ref_code) return u.ref_code;
  for (;;) { // 8 chars, no look-alike letters
    const code = [...crypto.randomBytes(8)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
    try { db.prepare('UPDATE users SET ref_code=? WHERE id=?').run(code, userId); return code; } catch { /* collision, retry */ }
  }
}
// Called from registration: remember who invited the new account (reward happens on first payment, see gateway.fulfil).
function applyReferral(newUserId, code) {
  if (!code) return;
  const inviter = db.prepare('SELECT id FROM users WHERE ref_code=? AND banned=0').get(String(code).trim().toUpperCase());
  if (inviter && inviter.id !== newUserId) db.prepare('UPDATE users SET referred_by=? WHERE id=?').run(inviter.id, newUserId);
}

module.exports = function mount(app, { needAuth, needRole, fail, clean, notify }) {
  // ---- gift coins to another reader
  app.post('/api/wallet/gift', needAuth, (req, res) => {
    const coins = parseInt(req.body.coins, 10), note = clean(req.body.message, 140);
    if (!(coins >= RULES.giftMin && coins <= RULES.giftMax)) return fail(res, 400, `Gift ${RULES.giftMin}-${RULES.giftMax} coins.`);
    const to = db.prepare('SELECT id, username, banned FROM users WHERE username=?').get(clean(req.body.to, 24));
    if (!to || to.banned) return fail(res, 404, 'No reader with that username.');
    if (to.id === req.user.id) return fail(res, 400, "You can't gift coins to yourself.");
    if (now() - req.user.created_at < 24 * 3600_000) return fail(res, 403, 'New accounts can send gifts after 24 hours.');
    try {
      db.transaction(() => {
        if (db.prepare('SELECT coins FROM users WHERE id=?').get(req.user.id).coins < coins) throw new Error('coins');
        db.prepare('UPDATE users SET coins=coins-? WHERE id=?').run(coins, req.user.id);
        db.prepare('UPDATE users SET coins=coins+? WHERE id=?').run(coins, to.id);
        const tx = db.prepare('INSERT INTO transactions(user_id,type,coins,note,created_at) VALUES(?,?,?,?,?)');
        tx.run(req.user.id, 'gift_sent', -coins, `Gift to ${to.username}${note ? ': ' + note : ''}`, now());
        tx.run(to.id, 'gift_received', coins, `Gift from ${req.user.username}${note ? ': ' + note : ''}`, now());
      })();
    } catch (e) { return e.message === 'coins' ? fail(res, 402, 'Not enough coins.') : fail(res, 500, e.message); }
    notify(to.id, `🎁 ${req.user.username} gifted you ${coins} coins${note ? `: "${note}"` : ''}`, '#/wallet');
    res.json({ ok: true, coins: db.prepare('SELECT coins FROM users WHERE id=?').get(req.user.id).coins });
  });

  // ---- referral program
  app.get('/api/me/referral', needAuth, (req, res) => {
    const code = refCodeFor(req.user.id);
    const invited = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(ref_rewarded),0) rewarded FROM users WHERE referred_by=?').get(req.user.id);
    res.json({ code, invited: invited.n, rewarded: invited.rewarded, bonus: RULES.referralBonus, earned: invited.rewarded * RULES.referralBonus });
  });

  // ---- creator earnings CSV (for accounting / taxes)
  app.get('/api/creator/earnings.csv', needRole('creator', 'admin'), (req, res) => {
    const rows = db.prepare(`SELECT e.created_at, e.source, s.title, e.coins, e.cents, e.available_at, e.payout_id, p.status payout_status
      FROM earnings e LEFT JOIN series s ON s.id=e.series_id LEFT JOIN payouts p ON p.id=e.payout_id WHERE e.creator_id=? ORDER BY e.created_at DESC`).all(req.user.id);
    const q = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; }; // also blocks CSV formula injection
    const iso = t => t ? new Date(t).toISOString() : '';
    const csv = ['date,source,series,coins,earned_usd,available_from,payout_id,payout_status',
      ...rows.map(r => [iso(r.created_at), r.source, r.title, r.coins, (r.cents / 100).toFixed(4), iso(r.available_at), r.payout_id, r.payout_status].map(q).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inkverse-earnings-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  });
};
module.exports.applyReferral = applyReferral;
