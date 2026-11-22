// End-to-end API smoke test: runs against a throwaway database on a random port.  `npm test`
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `inkverse-test-${Date.now()}.db`);
process.env.HOLD_DAYS = '0';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp_whsec_test';
const WebSocket = require('ws');
const { server } = require('./index');
const assert = require('assert');

let base, token = {};
const call = async (m, p, body, who) => {
  const r = await fetch(base + '/api' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + token[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const ok = (name, cond) => { assert(cond, 'FAILED: ' + name); console.log('  ✓', name); };

server.listen(0, async () => {
  base = 'http://localhost:' + server.address().port;
  try {
    for (const [k, l, pw] of [['reader', 'ReaderRay', 'Reader123!'], ['nova', 'NovaInk', 'Creator123!'], ['admin', 'admin', 'Admin123!']]) token[k] = (await call('POST', '/auth/login', { login: l, password: pw })).data.token;
    ok('logins work', token.reader && token.nova && token.admin);
    ok('reader cannot create series', (await call('POST', '/series', { title: 'x', type: 'comic' }, 'reader')).status === 403);
    ok('register requires terms', (await call('POST', '/auth/register', { username: 'newbie', email: 'n@x.io', password: 'password1' })).status === 400);

    const list = (await call('GET', '/series')).data; ok('series list seeded', list.length >= 6);
    const novel = list.find(s => s.type === 'novel' && s.creator === 'NovaInk') || list.find(s => s.type === 'novel');
    const owner = novel.creator === 'NovaInk' ? 'nova' : null;

    // premium unlock + revenue split
    const starfall = list.find(s => s.title === 'Starfall Academy'); const detail = (await call('GET', '/series/' + starfall.id, null, 'reader')).data;
    const locked = detail.chapters.find(c => c.locked); ok('premium chapter locked for reader', !!locked);
    ok('locked content withheld', (await call('GET', '/chapters/' + locked.id, null, 'reader')).data.pages === undefined);
    const before = (await call('GET', '/wallet', null, 'reader')).data.coins;
    ok('unlock succeeds', (await call('POST', `/chapters/${locked.id}/unlock`, null, 'reader')).status === 200);
    ok('coins deducted', (await call('GET', '/wallet', null, 'reader')).data.coins === before - locked.price_coins);
    ok('content now served', Array.isArray((await call('GET', '/chapters/' + locked.id, null, 'reader')).data.pages));
    const dash = (await call('GET', '/creator/dashboard', null, 'nova')).data;
    const expected = locked.price_coins * 0.8 * 0.7; ok('creator earns 70% of net coin value', Math.abs(dash.earnings.lifetime - expected) < 0.01);
    ok('payout below minimum rejected', (await call('POST', '/creator/payout', null, 'nova')).status === 400);

    // scheduling
    const mk = (mode) => call('POST', `/series/${starfall.id}/chapters`, null, 'nova');
    ok('scheduled chapter hidden from public', !(await call('GET', '/series/' + starfall.id)).data.chapters.some(c => c.scheduled));

    // moderation
    const ch = (await call('GET', '/channels')).data[0];
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws'); const got = [];
    await new Promise(r => ws.on('open', r)); ws.on('message', m => got.push(JSON.parse(m)));
    ws.send(JSON.stringify({ type: 'join', channel: ch.id, token: token.reader })); await new Promise(r => setTimeout(r, 200));
    ws.send(JSON.stringify({ type: 'msg', body: 'hello everyone ||spoiler||' })); await new Promise(r => setTimeout(r, 200));
    ok('chat message broadcast', got.some(m => m.type === 'msg' && m.message.body.includes('hello')));
    ws.send(JSON.stringify({ type: 'msg', body: 'you are a sh1t' })); ws.send(JSON.stringify({ type: 'msg', body: 'you are a shit' })); await new Promise(r => setTimeout(r, 300));
    ok('rate limit blocks rapid messages', got.some(m => m.type === 'error' && /too fast|Slow/.test(m.error)));
    await new Promise(r => setTimeout(r, 1300)); ws.send(JSON.stringify({ type: 'msg', body: 'what a fucking day' })); await new Promise(r => setTimeout(r, 300));
    ok('profanity filtered', got.some(m => m.type === 'msg' && /\*{3,}/.test(m.message.body)));
    ok('strike recorded', (await call('GET', '/me', null, 'reader')).data.strikes >= 1);
    const msgId = got.filter(m => m.type === 'msg').pop().message.id;
    await call('POST', '/report', { target_type: 'message', target_id: msgId, reason: 'test' }, 'reader');
    const reports = (await call('GET', '/admin/reports', null, 'admin')).data; ok('report reaches admin queue', reports.length >= 1);
    ok('non-admin cannot read queue', (await call('GET', '/admin/reports', null, 'reader')).status === 403);
    await call('POST', '/admin/reports/' + reports[0].id, { action: 'hide' }, 'admin');
    ok('hidden message removed from history', !(await call('GET', '/channels/' + ch.id)).data.messages.some(m => m.id === msgId));
    ws.close();

    // ---- advanced features
    const ck = await call('POST', '/checkin', null, 'reader'); ok('daily check-in grants coins', ck.status === 200 && ck.data.reward === 5 && ck.data.streak === 1);
    ok('second check-in same day blocked', (await call('POST', '/checkin', null, 'reader')).status === 400);
    const freeCh = detail.chapters.find(c => !c.locked && !c.scheduled);
    ok('react to chapter', (await call('POST', `/chapters/${freeCh.id}/react`, { emoji: '🔥' }, 'reader')).data.on === true);
    ok('reaction counted', (await call('GET', '/chapters/' + freeCh.id, null, 'reader')).data.reactions['🔥'] === 1);
    ok('bad emoji rejected', (await call('POST', `/chapters/${freeCh.id}/react`, { emoji: '💩' }, 'reader')).status === 400);
    const recs = (await call('GET', '/recommendations', null, 'reader')).data; ok('recommendations returned with reasons', recs.length > 0 && !!recs[0].reason);
    ok('search suggestions', (await call('GET', '/search/suggest?q=neo')).data.some(r => /Neon/i.test(r.title)));
    const an = (await call('GET', '/creator/analytics', null, 'nova')).data; ok('analytics has 30 days + supporters', an.views.length === 30 && an.supporters[0]?.username === 'ReaderRay');
    ok('badges endpoint', (await call('GET', '/me/badges', null, 'reader')).data.length >= 8);
    const ap = await call('POST', '/appeals', { text: 'I was quoting a movie, not insulting anyone, please review.' }, 'reader'); ok('appeal filed', ap.status === 200);
    const apl = (await call('GET', '/admin/appeals', null, 'admin')).data[0]; const strikesBefore = (await call('GET', '/me', null, 'reader')).data.strikes;
    await call('POST', '/admin/appeals/' + apl.id, { action: 'accept' }, 'admin'); ok('accepted appeal removes a strike', (await call('GET', '/me', null, 'reader')).data.strikes === strikesBefore - 1);
    await call('POST', '/admin/words', { word: 'blorpfish' }, 'admin');
    const ws2 = new WebSocket(base.replace('http', 'ws') + '/ws'); const got2 = []; await new Promise(r => ws2.on('open', r)); ws2.on('message', m => got2.push(JSON.parse(m)));
    ws2.send(JSON.stringify({ type: 'join', channel: ch.id, token: token.nova })); await new Promise(r => setTimeout(r, 200));
    ws2.send(JSON.stringify({ type: 'msg', body: 'you blorpfish' })); await new Promise(r => setTimeout(r, 300));
    ok('admin-added word is filtered live', got2.some(m => m.type === 'msg' && m.message.body.includes('*******')) ); ws2.close();
    const rid = (await call('GET', '/me', null, 'reader')).data.id;
    await call('POST', '/admin/users/' + rid, { action: 'promote' }, 'admin'); ok('admin can promote a moderator', (await call('GET', '/admin/overview', null, 'reader')).status === 200);
    await call('POST', '/admin/users/' + rid, { action: 'demote' }, 'admin'); ok('admin can demote a moderator', (await call('GET', '/admin/overview', null, 'reader')).status === 403);
    ok('audit log records admin actions', (await call('GET', '/admin/audit', null, 'admin')).data.length >= 3);

    // ---- Stripe webhook (signature, idempotency, amount check) & password reset
    const crypto = require('crypto');
    const hook = async (obj, secret = 'whsec_test_secret') => {
      const raw = JSON.stringify(obj), t = Math.floor(Date.now() / 1000), sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
      const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: raw });
      return r.status;
    };
    const me0 = (await call('GET', '/me', null, 'reader')).data; const coins0 = (await call('GET', '/wallet', null, 'reader')).data.coins;
    const evt = (id, amount) => ({ type: 'checkout.session.completed', data: { object: { id, payment_status: 'paid', client_reference_id: String(me0.id), metadata: { pack: 'p500' }, amount_total: amount, currency: 'usd' } } });
    ok('webhook with bad signature rejected', (await hook(evt('cs_bad', 449), 'wrong_secret')) === 400);
    ok('valid webhook accepted', (await hook(evt('cs_1', 449))) === 200);
    ok('coins credited by webhook', (await call('GET', '/wallet', null, 'reader')).data.coins === coins0 + 500);
    await hook(evt('cs_1', 449)); ok('replayed webhook does not double-credit', (await call('GET', '/wallet', null, 'reader')).data.coins === coins0 + 500);
    await hook(evt('cs_2', 1)); ok('wrong amount is ignored', (await call('GET', '/wallet', null, 'reader')).data.coins === coins0 + 500);
    ok('checkout refused when Stripe not configured', (await call('POST', '/wallet/checkout', { pack: 'p200' }, 'reader')).status === 400);
    let captured = ''; const origLog = console.log; console.log = (...a) => { captured += a.join(' '); }; 
    await call('POST', '/auth/forgot', { email: 'reader@inkverse.test' }); await new Promise(r => setTimeout(r, 200)); console.log = origLog;
    const tok = (captured.match(/reset\?token=([a-f0-9]{64})/) || [])[1]; ok('reset email generated', !!tok);
    ok('unknown email gives same response', (await call('POST', '/auth/forgot', { email: 'nobody@nowhere.io' })).status === 200);
    ok('bad reset token rejected', (await call('POST', '/auth/reset', { token: 'x'.repeat(64), password: 'NewPassw0rd!' })).status === 400);
    ok('password reset works', (await call('POST', '/auth/reset', { token: tok, password: 'NewPassw0rd!' })).status === 200);
    ok('login with new password', (await call('POST', '/auth/login', { login: 'ReaderRay', password: 'NewPassw0rd!' })).status === 200);
    ok('reset token is single-use', (await call('POST', '/auth/reset', { token: tok, password: 'Another1234!' })).status === 400);

    // ---- payment gateway: orders, coupons, demo checkout, Razorpay webhook, refunds
    const coinsOf = async who => (await call('GET', '/wallet', null, who)).data.coins;
    const gws = (await call('GET', '/pay/gateways')).data.gateways; ok('demo gateway listed when no keys are set', gws.length === 1 && gws[0].id === 'demo');
    ok('unknown pack rejected', (await call('POST', '/pay/orders', { pack: 'p999', gateway: 'demo' }, 'reader')).status === 400);
    ok('disabled gateway rejected', (await call('POST', '/pay/orders', { pack: 'p200', gateway: 'razorpay' }, 'reader')).status === 400);
    ok('admin creates coupon', (await call('POST', '/admin/coupons', { code: 'welcome50', bonus_pct: 50, max_uses: 10 }, 'admin')).status === 200);
    ok('non-admin cannot create coupon', (await call('POST', '/admin/coupons', { code: 'HACK', bonus_pct: 100 }, 'reader')).status === 403);
    ok('coupon preview shows bonus', (await call('POST', '/pay/coupon', { code: 'WELCOME50', pack: 'p500' }, 'reader')).data.bonus_coins === 250);
    ok('bad coupon rejected', (await call('POST', '/pay/orders', { pack: 'p500', gateway: 'demo', coupon: 'NOPE' }, 'reader')).status === 400);
    const c1 = await coinsOf('reader');
    const ord = (await call('POST', '/pay/orders', { pack: 'p500', gateway: 'demo', coupon: 'WELCOME50' }, 'reader')).data.order;
    ok('order priced on the server in INR', ord.amount === 34900 && ord.currency === 'INR' && ord.bonus_coins === 250 && ord.status === 'created');
    ok('no coins before payment confirmed', (await coinsOf('reader')) === c1);
    ok('demo confirm pays the order', (await call('POST', '/pay/demo/confirm', { order_id: ord.id }, 'reader')).data.order.status === 'paid');
    ok('coins + coupon bonus credited', (await coinsOf('reader')) === c1 + 750);
    await call('POST', '/pay/demo/confirm', { order_id: ord.id }, 'reader'); ok('confirming twice does not double-credit', (await coinsOf('reader')) === c1 + 750);
    ok('coupon is single-use per reader', (await call('POST', '/pay/orders', { pack: 'p200', gateway: 'demo', coupon: 'WELCOME50' }, 'reader')).status === 400);
    ok('other users cannot read the receipt', (await call('GET', '/pay/orders/' + ord.id, null, 'nova')).status === 404);
    ok('owner can read the receipt', (await call('GET', '/pay/orders/' + ord.id, null, 'reader')).data.display === '₹349.00');
    const ord2 = (await call('POST', '/pay/orders', { pack: 'p200', gateway: 'demo' }, 'reader')).data.order;
    ok('declined payment returns 402', (await call('POST', '/pay/demo/confirm', { order_id: ord2.id, outcome: 'fail' }, 'reader')).status === 402);
    ok('declined order marked failed, no coins', (await call('GET', '/pay/orders/' + ord2.id, null, 'reader')).data.status === 'failed' && (await coinsOf('reader')) === c1 + 750);
    ok('someone else cannot confirm my order', (await call('POST', '/pay/demo/confirm', { order_id: ord2.id }, 'nova')).status === 404);
    // Razorpay webhook (no API keys needed: the order row is created the way /pay/orders would)
    const { db } = require('./db'); const readerId = (await call('GET', '/me', null, 'reader')).data.id;
    db.prepare("INSERT INTO orders(id,user_id,pack_id,coins,amount,currency,gateway,gateway_order_id,created_at) VALUES('ord_rzp1',?,'p1200',1200,79900,'INR','razorpay','order_RZP1',?)").run(readerId, Date.now());
    db.prepare("INSERT INTO orders(id,user_id,pack_id,coins,amount,currency,gateway,gateway_order_id,created_at) VALUES('ord_rzp2',?,'p2600',2600,159900,'INR','razorpay','order_RZP2',?)").run(readerId, Date.now());
    const rzHook = async (orderId, amount, secret = 'rzp_whsec_test') => {
      const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_' + orderId, order_id: orderId, amount, currency: 'INR', status: 'captured' } } } });
      return (await fetch(base + '/api/razorpay/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw })).status;
    };
    const c2 = await coinsOf('reader');
    ok('razorpay webhook with bad signature rejected', (await rzHook('order_RZP1', 79900, 'nope')) === 400);
    ok('signed razorpay webhook accepted', (await rzHook('order_RZP1', 79900)) === 200);
    ok('razorpay payment credits coins', (await coinsOf('reader')) === c2 + 1200);
    await rzHook('order_RZP1', 79900); ok('razorpay webhook replay ignored', (await coinsOf('reader')) === c2 + 1200);
    await rzHook('order_RZP2', 100); ok('tampered razorpay amount not credited', (await coinsOf('reader')) === c2 + 1200 && (await call('GET', '/pay/orders/ord_rzp2', null, 'reader')).data.status === 'failed');
    ok('verify endpoint refuses when razorpay keys missing', (await call('POST', '/pay/razorpay/verify', { order_id: 'ord_rzp1' }, 'reader')).status === 400);
    // refunds
    const c3 = await coinsOf('reader');
    ok('admin refunds a demo order', (await call('POST', '/admin/orders/' + ord.id + '/refund', null, 'admin')).data.coinsRemoved === 750);
    ok('refund removes coins & marks order', (await coinsOf('reader')) === c3 - 750 && (await call('GET', '/pay/orders/' + ord.id, null, 'reader')).data.status === 'refunded');
    ok('cannot refund twice', (await call('POST', '/admin/orders/' + ord.id + '/refund', null, 'admin')).status === 400);
    const rev = (await call('GET', '/admin/revenue', null, 'admin')).data; ok('revenue report by gateway', rev.byGateway.some(g => g.gateway === 'razorpay' && g.amount === 79900));
    // referrals + gifts
    const refc = (await call('GET', '/me/referral', null, 'reader')).data.code; ok('referral code issued', /^[A-Z2-9]{8}$/.test(refc));
    const reg = await call('POST', '/auth/register', { username: 'invitee1', email: 'invitee1@x.io', password: 'password123', acceptTerms: true, ref: refc }); token.inv = reg.data.token;
    const c4 = await coinsOf('reader');
    const io = (await call('POST', '/pay/orders', { pack: 'p200', gateway: 'demo' }, 'inv')).data.order; await call('POST', '/pay/demo/confirm', { order_id: io.id }, 'inv');
    ok('referral pays both people after first purchase', (await coinsOf('reader')) === c4 + 100 && (await coinsOf('inv')) === 300);
    const io2 = (await call('POST', '/pay/orders', { pack: 'p200', gateway: 'demo' }, 'inv')).data.order; await call('POST', '/pay/demo/confirm', { order_id: io2.id }, 'inv');
    ok('referral reward only once', (await coinsOf('reader')) === c4 + 100);
    ok('brand-new accounts cannot send gifts', (await call('POST', '/wallet/gift', { to: 'ReaderRay', coins: 20 }, 'inv')).status === 403);
    const n0 = await coinsOf('nova'), r0 = await coinsOf('reader');
    ok('gift coins to another reader', (await call('POST', '/wallet/gift', { to: 'NovaInk', coins: 50, message: 'love it' }, 'reader')).status === 200);
    ok('gift moves coins', (await coinsOf('nova')) === n0 + 50 && (await coinsOf('reader')) === r0 - 50);
    ok('cannot gift yourself', (await call('POST', '/wallet/gift', { to: 'ReaderRay', coins: 50 }, 'reader')).status === 400);
    const csv = await fetch(base + '/api/creator/earnings.csv', { headers: { Authorization: 'Bearer ' + token.nova } });
    ok('creator earnings CSV export', csv.headers.get('content-type').includes('text/csv') && (await csv.text()).includes('date,source,series'));
    // chat: delete own message
    const ws3 = new WebSocket(base.replace('http', 'ws') + '/ws'); const got3 = []; await new Promise(r => ws3.on('open', r)); ws3.on('message', m => got3.push(JSON.parse(m)));
    ws3.send(JSON.stringify({ type: 'join', channel: ch.id, token: token.inv })); await new Promise(r => setTimeout(r, 200));
    ws3.send(JSON.stringify({ type: 'msg', body: 'oops wrong channel' })); await new Promise(r => setTimeout(r, 200));
    const mine = got3.find(m => m.type === 'msg'); ws3.send(JSON.stringify({ type: 'delete', id: mine?.message.id })); await new Promise(r => setTimeout(r, 200));
    ok('author can delete own chat message', got3.some(m => m.type === 'hide' && m.deleted && m.id === mine.message.id)); ws3.close();

    // DMCA takedown
    ok('dmca claim filed', (await call('POST', '/dmca', { series_id: starfall.id, claimant: 'Acme', email: 'a@b.co', details: 'This is my original work and it was copied without permission.' })).status === 200);
    const d = (await call('GET', '/admin/dmca', null, 'admin')).data[0]; await call('POST', '/admin/dmca/' + d.id, { action: 'takedown' }, 'admin');
    ok('taken-down series hidden publicly', (await call('GET', '/series/' + starfall.id)).status === 404);
    console.log('\nAll checks passed.'); process.exit(0);
  } catch (e) { console.error('\n' + e.message); process.exit(1); }
});
