import { supabase } from './supabase.js';

export const MIME_IMAGES_PDF = ['image/jpeg', 'image/png', 'application/pdf'];
export const MIME_DOCS = [
  ...MIME_IMAGES_PDF,
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
export const MIME_CASE = [
  ...MIME_DOCS,
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};

/** Client-side validation (the server re-validates through bucket limits + constraints). */
export function validateFile(file, { maxMb = 10, mimes = MIME_DOCS } = {}) {
  if (!file) return 'no_file';
  if (!mimes.includes(file.type)) return 'file_type';
  if (file.size > maxMb * 1024 * 1024) return 'file_size';
  if (file.size === 0) return 'file_empty';
  return null;
}

/** Uploads to `${folder}/${uuid}.${ext}`. Original filenames never become paths. */
export async function uploadFile(bucket, folder, file) {
  const path = `${folder}/${crypto.randomUUID()}.${EXT[file.type] || 'bin'}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file.type, upsert: false, cacheControl: '0',
  });
  if (error) throw error;
  return { path, file_name: file.name, mime_type: file.type, size_bytes: file.size };
}

/** Private buckets: always use a short-lived signed URL (never a public URL).
 *  `download` may be true or the file name the browser should save it as. */
export async function openSigned(bucket, path, { download = false, seconds = 60 } = {}) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, seconds, download ? { download } : undefined);
  if (error) throw error;
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
}

/** Best effort: a leftover object is harmless, so a failed delete never blocks the caller. */
export async function removeFiles(bucket, paths) {
  const list = paths.filter(Boolean);
  if (list.length) await supabase.storage.from(bucket).remove(list);
}

export const MIME_AVATAR = ['image/jpeg', 'image/png', 'image/webp'];
const AVATAR_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Profile photos live in the PUBLIC `avatars` bucket under `{folder}/`; returns the public URL. */
export async function uploadPublicImage(folder, file) {
  const path = `${folder}/${crypto.randomUUID()}.${AVATAR_EXT[file.type] || 'jpg'}`;
  const { error } = await supabase.storage.from('avatars').upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
  if (error) throw error;
  return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

/** Path inside the avatars bucket for a public URL we produced (null for anything else). */
export function avatarPathOf(url) {
  const m = /\/storage\/v1\/object\/public\/avatars\/(.+)$/.exec(url || '');
  return m ? decodeURIComponent(m[1]) : null;
}
