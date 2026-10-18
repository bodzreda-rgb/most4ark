import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ar } from '../locales/ar.js';
import { en } from '../locales/en.js';
import { addDays, dayKeyOf, rangeFor, startOfWeek, utcIsoToZonedLocal, zonedLocalToUtcIso, tzOffsetMinutes } from '../lib/dates.js';
import { csvCell, toCsv } from '../lib/csv.js';
import { fillTemplate, missingFields, placeholdersOf } from '../lib/templates.js';
import { translate } from '../lib/i18n.jsx';
import { errorKey } from '../lib/errors.js';
import { validateFile } from '../lib/storage.js';

describe('dates (Africa/Cairo)', () => {
  it('uses +2 in winter and +3 in summer', () => {
    expect(tzOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Africa/Cairo')).toBe(120);
    expect(tzOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Africa/Cairo')).toBe(180);
  });
  it('round-trips local <-> UTC', () => {
    const iso = zonedLocalToUtcIso('2026-07-15T09:30', 'Africa/Cairo');
    expect(iso).toBe('2026-07-15T06:30:00.000Z');
    expect(utcIsoToZonedLocal(iso, 'Africa/Cairo')).toBe('2026-07-15T09:30');
    expect(zonedLocalToUtcIso('2026-01-15T09:30', 'Africa/Cairo')).toBe('2026-01-15T07:30:00.000Z');
  });
  it('day key follows the zone, not UTC', () => {
    expect(dayKeyOf('2026-03-10T22:30:00Z', 'Africa/Cairo')).toBe('2026-03-11');
  });
  it('week starts on Saturday', () => {
    expect(startOfWeek('2026-10-18')).toBe('2026-10-17');   // Sunday -> previous Saturday
    expect(startOfWeek('2026-10-17')).toBe('2026-10-17');
  });
  it('month range covers whole weeks', () => {
    const r = rangeFor('month', '2026-10-18', 'Africa/Cairo');
    expect(r.days.length % 7).toBe(0);
    expect(r.days).toContain('2026-10-01');
    expect(r.days).toContain('2026-10-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('csv', () => {
  it('neutralises formula injection and quotes', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(toCsv([{ a: 'x' }], [{ key: 'a', label: 'A' }]).startsWith('﻿')).toBe(true);
  });
});

describe('templates', () => {
  const body = 'اسم {{client}} و {{ court }} و {{client}}';
  it('finds unique placeholders and fills known values only', () => {
    expect(placeholdersOf(body)).toEqual(['client', 'court']);
    expect(fillTemplate(body, { client: 'أحمد' })).toBe('اسم أحمد و {{ court }} و أحمد');
    expect(missingFields(body, { client: 'x' })).toEqual(['court']);
  });
});

describe('errors / files', () => {
  it('maps known server errors', () => {
    expect(errorKey({ message: 'rate_limited' })).toBe('err.rate_limited');
    expect(errorKey({ code: '42501', message: 'x' })).toBe('err.forbidden');
    expect(errorKey(null)).toBe('err.unknown');
  });
  it('validates uploads', () => {
    expect(validateFile({ type: 'application/pdf', size: 100 })).toBeNull();
    expect(validateFile({ type: 'application/x-msdownload', size: 100 })).toBe('file_type');
    expect(validateFile({ type: 'application/pdf', size: 20 * 1024 * 1024 })).toBe('file_size');
  });
});

describe('i18n', () => {
  it('ar and en have identical keys', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });
  it('no empty values', () => {
    for (const d of [ar, en]) for (const [k, v] of Object.entries(d)) expect(v.trim(), k).not.toBe('');
  });
  it('interpolates', () => {
    expect(translate('en', 'settings.announcement_sent', { n: 3 })).toContain('3');
  });
  it('every statically referenced key exists', () => {
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'locales') walk(p); } else if (/\.(jsx?|js)$/.test(e.name)) files.push(p);
    });
    walk(path.resolve(__dirname, '..'));
    const used = new Set();
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
      for (const m of src.matchAll(/label: '(nav\.[a-z_]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !(k in en) && !k.endsWith('.'));
    expect(missing).toEqual([]);
  });
});
