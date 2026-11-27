// Cloudflare R2 (S3-compatible) for the Media Library. Signs requests itself (AWS Signature V4), no SDK.
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET. The bucket is private: every
// browser link is a presigned URL that expires.
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const ACCOUNT = env('R2_ACCOUNT_ID'), KEY_ID = env('R2_ACCESS_KEY_ID'), SECRET = env('R2_SECRET_ACCESS_KEY'), BUCKET = env('R2_BUCKET');
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
export const r2Configured = () => !!(ACCOUNT && KEY_ID && SECRET && BUCKET);

const te = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (d: string | Uint8Array) => hex(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? te.encode(d) : d));
async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, te.encode(data));
}
// RFC 3986 encoding (S3 wants ! ' ( ) * encoded too)
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (key: string) => '/' + BUCKET + '/' + key.split('/').map(enc).join('/');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261126T120000Z

async function signingKey(day: string) {
  let k = await hmac(te.encode('AWS4' + SECRET), day);
  k = await hmac(k, 'auto'); k = await hmac(k, 's3'); return hmac(k, 'aws4_request');
}
const canonQuery = (q: Record<string, string>) => Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');

/** Presigned URL (GET for downloads, PUT for direct browser uploads). Max 7 days. */
export async function presign(method: 'GET' | 'PUT' | 'HEAD', key: string, seconds = 6 * 3600, extra: Record<string, string> = {}) {
  const now = stamp(), day = now.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
  const q: Record<string, string> = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${KEY_ID}/${scope}`, 'X-Amz-Date': now,
    'X-Amz-Expires': String(Math.min(604800, Math.max(1, Math.floor(seconds)))), 'X-Amz-SignedHeaders': 'host', ...extra };
  const path = encPath(key), cq = canonQuery(q);
  const creq = [method, path, cq, `host:${HOST}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', now, scope, await sha256(creq)].join('\n');
  const sig = hex(await hmac(await signingKey(day), sts));
  return `https://${HOST}${path}?${cq}&X-Amz-Signature=${sig}`;
}
/** A download link that saves under `filename` (Content-Disposition attachment) or opens inline. */
export function downloadUrl(key: string, filename: string, seconds = 6 * 3600, attachment = true, type?: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const extra: Record<string, string> = { 'response-content-disposition': `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${enc(filename)}` };
  if (type) extra['response-content-type'] = type;
  return presign('GET', key, seconds, extra);
}

/** Server-side request with header signing. body: bytes (hashed) or null. */
export async function r2(method: string, key: string, opts: { body?: Uint8Array | null; query?: Record<string, string>; headers?: Record<string, string>; bucketLevel?: boolean } = {}) {
  const now = stamp(), day = now.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
  const body = opts.body ?? null;
  const payloadHash = body ? await sha256(body) : await sha256('');
  const h: Record<string, string> = { host: HOST, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now };
  for (const [k, v] of Object.entries(opts.headers ?? {})) h[k.toLowerCase()] = v;
  const names = Object.keys(h).sort();
  const path = opts.bucketLevel ? '/' + BUCKET + '/' : encPath(key), cq = canonQuery(opts.query ?? {});
  const creq = [method, path, cq, names.map(n => `${n}:${String(h[n]).trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const sts = ['AWS4-HMAC-SHA256', now, scope, await sha256(creq)].join('\n');
  const sig = hex(await hmac(await signingKey(day), sts));
  const headers: Record<string, string> = { ...h, Authorization: `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` };
  delete headers.host;
  return fetch(`https://${HOST}${path}${cq ? '?' + cq : ''}`, { method, headers, body });
}
export async function put(key: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const r = await r2('PUT', key, { body: bytes, headers: { 'content-type': type } });
  if (!r.ok) throw new Error(`R2 upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  await r.body?.cancel();
}
export async function get(key: string, range?: string) { return r2('GET', key, { headers: range ? { range } : {} }); }
export async function head(key: string) { const r = await r2('HEAD', key); return r.ok ? { size: +(r.headers.get('content-length') || 0), type: r.headers.get('content-type') } : null; }
export async function del(key: string) { const r = await r2('DELETE', key); await r.body?.cancel(); return r.ok || r.status === 404; }

/* ----- multipart (prebuilt Download All zips) ----- */
export async function mpStart(key: string, type = 'application/zip') {
  const r = await r2('POST', key, { query: { uploads: '' }, headers: { 'content-type': type } });
  const t = await r.text(); if (!r.ok) throw new Error('R2 multipart start ' + r.status + ' ' + t.slice(0, 200));
  return t.match(/<UploadId>([^<]+)<\/UploadId>/)![1];
}
export async function mpPart(key: string, uploadId: string, n: number, bytes: Uint8Array) {
  const r = await r2('PUT', key, { body: bytes, query: { partNumber: String(n), uploadId } });
  if (!r.ok) throw new Error('R2 part ' + n + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  await r.body?.cancel(); return r.headers.get('etag')!;
}
export async function mpDone(key: string, uploadId: string, etags: string[]) {
  const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  const r = await r2('POST', key, { body: te.encode(xml), query: { uploadId }, headers: { 'content-type': 'application/xml' } });
  const t = await r.text(); if (!r.ok || /<Error>/.test(t)) throw new Error('R2 multipart complete ' + r.status + ' ' + t.slice(0, 200));
}
export async function mpAbort(key: string, uploadId: string) { const r = await r2('DELETE', key, { query: { uploadId } }); await r.body?.cancel(); }

/* ----- bucket CORS (browsers upload from HQ and read files for "Save to Photos") ----- */
export async function setCors(origins: string[]) {
  const xml = `<CORSConfiguration><CORSRule>${['*'].map(o => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}<AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>Content-Length</ExposeHeader><ExposeHeader>Content-Disposition</ExposeHeader><ExposeHeader>Content-Type</ExposeHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>` +
    `<CORSRule>${origins.map(o => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')}<AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
  const body = te.encode(xml);
  const md5 = await (async () => { try { return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('MD5', body)))); } catch { return ''; } })();
  const r = await r2('PUT', '', { bucketLevel: true, body, query: { cors: '' }, headers: { 'content-type': 'application/xml', ...(md5 ? { 'content-md5': md5 } : {}) } });
  return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 300) };
}
export async function getCors() { const r = await r2('GET', '', { bucketLevel: true, query: { cors: '' } }); return { status: r.status, text: (await r.text()).slice(0, 600) }; }

/* ----- CRC-32 (stored per file at import so zips can be built without re-reading for checksums) ----- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(d: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
