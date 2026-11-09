import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = join(root, 'data');
const ordersFile = join(dataDir, 'orders.json');

// Tiny .env reader keeps the project dependency-free for local VS Code use.
try {
  const text = await readFile(join(root, '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch {}

await mkdir(dataDir, { recursive: true });
try { await readFile(ordersFile); } catch { await writeFile(ordersFile, '[]\n'); }

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const prices = { A5: 1200, A4: 2200, A3: 3800, Custom: 2200 };
const types = ['Portrait from a photo', 'Couple or family portrait', 'Pet portrait', 'Custom illustration', 'Something else'];
const styles = ['Coloured pencil', 'Watercolour', 'Minimal line art', 'Digital illustration', 'Help me choose'];
const numberOfSubjects = { '1': 0, '2': 600, '3': 1100, '4': 1600, pet: 300 };
function estimate(size, subjects) {
  if (!(size in prices) || !(subjects in numberOfSubjects)) throw new Error('Choose a valid artwork size and number of subjects.');
  return prices[size] + numberOfSubjects[subjects];
}
let writeQueue = Promise.resolve();
async function getOrders() { return JSON.parse(await readFile(ordersFile, 'utf8')); }
function saveOrders(orders) {
  writeQueue = writeQueue.then(() => writeFile(ordersFile, `${JSON.stringify(orders, null, 2)}\n`));
  return writeQueue;
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req, maxBytes = 6_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}
function clean(value, limit = 1000) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function hasAdminAccess(req) {
  const secret = process.env.ADMIN_API_KEY;
  if (!secret) return false;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(token), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function createPaymentOrder(req, res) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return json(res, 503, { error: 'Online payment is not configured yet.' });
  const input = await body(req, 20_000);
  const orders = await getOrders();
  const order = orders.find(item => item.id === clean(input.orderId, 80));
  if (!order) return json(res, 404, { error: 'Order enquiry not found.' });
  const receipt = `lk_${order.id.replaceAll('-', '').slice(0, 32)}`;
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: order.estimatedAmount * 100, currency: 'INR', receipt, notes: { enquiry_id: order.id, artist: 'Lovely Kumari' } })
  });
  const result = await response.json();
  if (!response.ok) return json(res, 502, { error: result.error?.description || 'Could not start payment.' });
  order.razorpayOrderId = result.id; order.paymentStatus = 'pending'; order.updatedAt = new Date().toISOString();
  await saveOrders(orders);
  json(res, 201, { keyId: process.env.RAZORPAY_KEY_ID, paymentOrderId: result.id, amount: result.amount, currency: result.currency, name: 'Lovely Kumari' });
}
async function verifyPayment(req, res) {
  if (!process.env.RAZORPAY_KEY_SECRET) return json(res, 503, { error: 'Online payment is not configured yet.' });
  const input = await body(req, 20_000);
  const orderId = clean(input.orderId, 80), paymentId = clean(input.razorpay_payment_id, 80), paymentOrderId = clean(input.razorpay_order_id, 80), signature = clean(input.razorpay_signature, 200);
  const orders = await getOrders();
  const order = orders.find(item => item.id === orderId);
  if (!order || !order.razorpayOrderId || order.razorpayOrderId !== paymentOrderId) return json(res, 400, { error: 'Payment does not match this order.' });
  const expected = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${paymentOrderId}|${paymentId}`).digest();
  let supplied; try { supplied = Buffer.from(signature, 'hex'); } catch { supplied = Buffer.alloc(0); }
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return json(res, 400, { error: 'Payment signature could not be verified.' });
  order.paymentStatus = 'signature_verified'; order.paymentId = paymentId; order.updatedAt = new Date().toISOString();
  await saveOrders(orders);
  json(res, 200, { ok: true, message: 'Payment response verified. Confirm captured status in Razorpay before fulfilling the order.' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, {
      artistName: 'Lovely Kumari', instagramUsername: clean(process.env.INSTAGRAM_USERNAME || ''),
      paymentReady: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      whatsappConfigured: Boolean(process.env.ARTIST_WHATSAPP), whatsappNumber: clean(process.env.ARTIST_WHATSAPP || '', 30)
    });
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'lovely-kumari-art-site' });
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const input = await body(req);
      const name = clean(input.name, 100), contact = clean(input.contact, 160), type = clean(input.type, 80), style = clean(input.style, 80), size = clean(input.size, 20), subjects = clean(input.people, 10);
      if (name.length < 2 || contact.length < 5) return json(res, 400, { error: 'Please enter your name and a valid way to contact you.' });
      if (!types.includes(type) || !styles.includes(style)) return json(res, 400, { error: 'Choose a valid artwork type and style.' });
      const estimatedAmount = estimate(size, subjects);
      const photo = input.photo && typeof input.photo === 'object' ? input.photo : null;
      if (photo && (!/^data:image\/(png|jpeg|webp);base64,/i.test(photo.data || '') || photo.data.length > 5_500_000)) return json(res, 400, { error: 'Reference photo must be a PNG, JPEG or WebP under 4 MB.' });
      const order = {
        id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'new', paymentStatus: 'unpaid',
        name, contact, type, style, size, subjects, background: clean(input.background, 80), deadline: clean(input.deadline, 30), idea: clean(input.idea, 2000), estimatedAmount,
        photo: photo ? { name: clean(photo.name, 180), data: photo.data } : null
      };
      const orders = await getOrders(); orders.unshift(order); await saveOrders(orders);
      return json(res, 201, { ok: true, orderId: order.id, estimatedAmount, message: 'Your enquiry has been saved.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/orders') {
      if (!hasAdminAccess(req)) return json(res, 401, { error: 'Admin access required.' });
      const orders = await getOrders(); return json(res, 200, orders.map(({ photo, ...order }) => order));
    }
    if (req.method === 'POST' && url.pathname === '/api/payments/create-order') return await createPaymentOrder(req, res);
    if (req.method === 'POST' && url.pathname === '/api/payments/verify') return await verifyPayment(req, res);
    if (req.method === 'GET' && url.pathname === '/api/instagram/feed') {
      const username = clean(process.env.INSTAGRAM_USERNAME || '');
      if (!username || !process.env.INSTAGRAM_USER_ID || !process.env.INSTAGRAM_ACCESS_TOKEN) return json(res, 200, { configured: false, username, data: [] });
      const endpoint = new URL(`https://graph.instagram.com/${encodeURIComponent(process.env.INSTAGRAM_API_VERSION || 'v25.0')}/${encodeURIComponent(process.env.INSTAGRAM_USER_ID)}/media`);
      endpoint.searchParams.set('fields', 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp'); endpoint.searchParams.set('limit', '6'); endpoint.searchParams.set('access_token', process.env.INSTAGRAM_ACCESS_TOKEN);
      const response = await fetch(endpoint); const result = await response.json();
      if (!response.ok) return json(res, 502, { configured: true, username, data: [], error: result.error?.message || 'Instagram feed is temporarily unavailable.' });
      return json(res, 200, { configured: true, username, data: result.data || [] });
    }
    if (req.method === 'GET') {
      const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = normalize(join(publicDir, requested));
      if (!file.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden.' });
      return createReadStream(file).on('error', () => { if (!res.headersSent) json(res, 404, { error: 'Not found.' }); }).pipe((res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }), res));
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    json(res, error.status || 500, { error: error.message || 'Something went wrong.' });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Lovely Kumari Art is running at http://localhost:${port}`));

