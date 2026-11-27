// The R2 part of the client download page (/d/<token>): photos, floor plans, files and Download All zips for an
// order whose Media Library is on R2 (bookings.media_store = 'r2'). Used by the `library` function (preview in HQ) and,
// once approved, by the `booking` function's deliveryFor. Keep this file identical in both functions.
//
// Pay Before Download is enforced here, on the server: when the order is locked (not paid, Pay Before Download on),
// no download link is made at all. The page gets watermarked previews only (served by the `media` function).
import { presign, downloadUrl } from './r2.ts';
import { sign, galleryAddress } from './lib.ts';

export const LINK_HOURS = 6; // photo links expire; the page link itself never does

// "123 Main St" -> "123-Main-St"
export const addrSlug = (b: any) => String(galleryAddress(b) || 'Photos').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'Photos';
const extOf = (name: string, fallback = 'jpg') => (String(name).match(/\.([a-z0-9]{2,5})$/i)?.[1] || fallback).toLowerCase().replace('jpeg', 'jpg');
// Download names: 123-Main-St-01.jpg (photos, in Media Library order), 123-Main-St-Floor-Plan-1.jpg, 123-Main-St-<file>.pdf
export function photoName(b: any, i: number, total: number, ext: string) {
  return `${addrSlug(b)}-${String(i + 1).padStart(Math.max(2, String(total).length), '0')}.${ext}`;
}
export function planName(b: any, i: number, total: number, ext: string) { return `${addrSlug(b)}-Floor-Plan${total > 1 ? '-' + (i + 1) : ''}.${ext}`; }
export function fileName(b: any, name: string) {
  const stem = String(name).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${addrSlug(b)}-${stem || 'File'}.${extOf(name, 'pdf')}`;
}
export const fullExt = (it: any) => extOf(it.name);

export const visible = (items: any[], kind: string) => items.filter(i => i.kind === kind && !i.hidden && (i.key_web || i.key_full)).sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));

export async function r2Delivery(b: any, items: any[], zips: any[], locked: boolean, currentSig: (variant: 'full' | 'web') => Promise<string | null>) {
  const s = LINK_HOURS * 3600, wm = { wm: 1 as const };
  const photos: any[] = [], floorplans: any[] = [], files: any[] = [], folders: any[] = [];
  const ph = visible(items, 'photo');
  for (const [i, it] of ph.entries()) {
    const web = it.key_web || it.key_full, thumb = it.key_thumb || web;
    const name = photoName(b, i, ph.length, it.key_full ? fullExt(it) : 'jpg'), webName = photoName(b, i, ph.length, 'jpg');
    const label = String(i + 1).padStart(2, '0');
    if (locked) photos.push({ id: it.id, name, label,
      thumb: await sign({ src: 'url', url: await presign('GET', thumb, 13 * 3600), v: 'thumb', name, ...wm }),
      view: await sign({ src: 'url', url: await presign('GET', web, 13 * 3600), v: 'preview', name, ...wm }), web: null, high: null, edit: it.edit_type || null });
    else photos.push({ id: it.id, name, label, edit: it.edit_type || null,
      thumb: await presign('GET', thumb, s), view: await presign('GET', web, s),
      web: await downloadUrl(web, webName, s), webName,
      high: it.key_full ? await downloadUrl(it.key_full, name, s) : null, highName: it.key_full ? name : null,
      size_web: it.size_web || null, size_full: it.size_full || null });
  }
  const fp = visible(items, 'floorplan');
  for (const [i, it] of fp.entries()) {
    const key = it.key_full || it.key_web, pdf = /\.pdf$/i.test(it.name), name = planName(b, i, fp.length, extOf(it.name));
    const img = pdf ? null : (it.key_thumb || it.key_web || it.key_full);
    floorplans.push({ id: it.id, name,
      thumb: img ? (locked ? await sign({ src: 'url', url: await presign('GET', img, 13 * 3600), v: 'thumb', name, ...wm }) : await presign('GET', img, s)) : null,
      view: img ? (locked ? await sign({ src: 'url', url: await presign('GET', key, 13 * 3600), v: 'preview', name, ...wm }) : await presign('GET', key, s)) : null,
      web: null, high: locked ? null : await downloadUrl(key, name, s) });
  }
  for (const it of visible(items, 'file')) {
    const name = fileName(b, it.name);
    files.push({ id: it.id, name, high: locked ? null : await downloadUrl(it.key_full || it.key_web, name, s) });
  }
  if (!locked && ph.length) {
    const z: any = { full: null, web: null, preparing: false };
    for (const v of ['full', 'web'] as const) {
      const row = zips.find(r => r.variant === v), want = await currentSig(v);
      if (!want) continue; // e.g. no Full Resolution files (imported Spiro orders)
      if (row && row.sig === want) z[v] = { url: await downloadUrl(row.key, `${addrSlug(b)}-${v === 'full' ? 'Full-Resolution' : 'Web-Size'}.zip`, s, true, 'application/zip'), size: row.size, count: row.count };
      else z.preparing = true;
    }
    folders.push({ zip: z.full?.url || z.web?.url || null, zipFull: z.full, zipWeb: z.web, preparing: z.preparing });
  }
  return { photos, floorplans, files, folders, fullResolution: ph.some(p => p.key_full) };
}
