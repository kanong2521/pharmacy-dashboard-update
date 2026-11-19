(function (global) {
  'use strict';

  const STORAGE_TZ_KEY = 'pharmacy_active_tz';
  const STORAGE_ERA_KEY = 'pharmacy_cal_era';
  const CHANNEL_NAME = 'pharmacy-tz-sync';

  // Conditional polyfills (modern-web-guidance: popover & Temporal)
  if (typeof document !== 'undefined' && !Object.hasOwn(HTMLElement.prototype, 'popover')) {
    const polyScript = document.createElement('script');
    polyScript.src = 'https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js';
    polyScript.async = true;
    document.head?.appendChild(polyScript);
  }

  let uidCounter = 0;
  const nextId = (prefix) => `${prefix}-${++uidCounter}`;

  const CURATED_ZONES = [
    { tz: 'Asia/Bangkok', label: 'กรุงเทพฯ · ประเทศไทย (ICT)' },
    { tz: 'Asia/Singapore', label: 'สิงคโปร์ (SGT)' },
    { tz: 'Asia/Tokyo', label: 'โตเกียว · ญี่ปุ่น (JST)' },
    { tz: 'UTC', label: 'เวลามาตรฐานสากล (UTC)' },
    { tz: 'Europe/London', label: 'ลอนดอน · สหราชอาณาจักร (GMT/BST)' },
    { tz: 'America/New_York', label: 'นิวยอร์ก · สหรัฐฯ ตะวันออก (EST/EDT)' },
    { tz: 'America/Los_Angeles', label: 'ลอสแอนเจลิส · สหรัฐฯ ตะวันตก (PST/PDT)' },
    { tz: 'Australia/Sydney', label: 'ซิดนีย์ · ออสเตรเลีย (AEST/AEDT)' }
  ];

  const TH_WEEKDAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const TH_MONTHS_LONG = [
    'มกราคม',
    'กุมภาพันธ์',
    'มีนาคม',
    'เมษายน',
    'พฤษภาคม',
    'มิถุนายน',
    'กรกฎาคม',
    'สิงหาคม',
    'กันยายน',
    'ตุลาคม',
    'พฤศจิกายน',
    'ธันวาคม'
  ];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  function isValidTimeZone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
      return true;
    } catch {
      return false;
    }
  }

  function getDetectedTimeZone() {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (isValidTimeZone(detected)) return detected;
    } catch {}
    return 'Asia/Bangkok';
  }

  function safeReadStorage(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  function safeWriteStorage(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch {}
  }

  let activeTz = (() => {
    const saved = safeReadStorage(STORAGE_TZ_KEY, '');
    return isValidTimeZone(saved) ? saved : getDetectedTimeZone();
  })();

  let activeEra = safeReadStorage(STORAGE_ERA_KEY, 'be') === 'ce' ? 'ce' : 'be';

  const listeners = new Set();
  const enhancedFields = new Map();
  let tickerMount = null;
  let tickerTimer = null;
  let activeTzPopover = null;
  let activeTzFilterQuery = '';

  const channel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

  function notifyListeners(detail = {}) {
    refreshAllEnhancedFields();
    renderTickerNow();
    for (const fn of listeners) {
      try {
        fn({ timeZone: activeTz, era: activeEra, ...detail });
      } catch (err) {
        console.error('PharmacyDateTime listener error:', err);
      }
    }
  }

  if (typeof globalThis.Temporal === 'undefined' && typeof document !== 'undefined') {
    import('https://esm.sh/temporal-polyfill')
      .then((mod) => {
        if (mod && mod.Temporal) {
          globalThis.Temporal = mod.Temporal;
          notifyListeners({ reason: 'temporal-ready' });
        }
      })
      .catch(() => {
        // Offline/CSP fallback uses Intl.DateTimeFormat seamlessly
      });
  }

  function localeForEra(era = activeEra) {
    return era === 'ce' ? 'th-TH-u-ca-gregory' : 'th-TH-u-ca-buddhist';
  }

  function setTimeZone(tz, { broadcast = true } = {}) {
    if (!isValidTimeZone(tz) || tz === activeTz) return false;
    activeTz = tz;
    safeWriteStorage(STORAGE_TZ_KEY, tz);
    if (broadcast && channel) {
      channel.postMessage({ type: 'tz-change', timeZone: tz, era: activeEra });
    }
    notifyListeners({ reason: 'timezone-change' });
    return true;
  }

  function setEra(era, { broadcast = true } = {}) {
    const normalized = era === 'ce' ? 'ce' : 'be';
    if (normalized === activeEra) return false;
    activeEra = normalized;
    safeWriteStorage(STORAGE_ERA_KEY, normalized);
    if (broadcast && channel) {
      channel.postMessage({ type: 'era-change', timeZone: activeTz, era: normalized });
    }
    notifyListeners({ reason: 'era-change' });
    return true;
  }

  if (channel) {
    channel.onmessage = (ev) => {
      const msg = ev.data || {};
      let changed = false;
      if (isValidTimeZone(msg.timeZone) && msg.timeZone !== activeTz) {
        activeTz = msg.timeZone;
        changed = true;
      }
      if ((msg.era === 'be' || msg.era === 'ce') && msg.era !== activeEra) {
        activeEra = msg.era;
        changed = true;
      }
      if (changed) notifyListeners({ reason: 'cross-tab-sync' });
    };
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('storage', (ev) => {
      if (ev.key === STORAGE_TZ_KEY && isValidTimeZone(ev.newValue) && ev.newValue !== activeTz) {
        activeTz = ev.newValue;
        notifyListeners({ reason: 'cross-tab-sync' });
      }
      if (ev.key === STORAGE_ERA_KEY && (ev.newValue === 'be' || ev.newValue === 'ce') && ev.newValue !== activeEra) {
        activeEra = ev.newValue;
        notifyListeners({ reason: 'cross-tab-sync' });
      }
    });
  }

  // Extract calendar & clock fields in an IANA time zone using Intl.DateTimeFormat fallback
  function intlPartsForEpoch(epochMs, tz = activeTz) {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    const map = {};
    for (const p of dtf.formatToParts(epochMs)) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour === '24' ? '0' : map.hour),
      minute: Number(map.minute),
      second: Number(map.second)
    };
  }

  function intlOffsetLabel(epochMs, tz = activeTz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset'
      }).formatToParts(epochMs);
      const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value || 'UTC';
      return tzPart;
    } catch {
      return 'UTC';
    }
  }

  function offsetMinutesToIso(mins) {
    const sign = mins >= 0 ? '+' : '-';
    const abs = Math.abs(Math.round(mins));
    return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }

  function computeIntlOffsetMinutes(epochMs, tz = activeTz) {
    const p = intlPartsForEpoch(epochMs, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const truncatedSec = Math.floor(epochMs / 1000) * 1000;
    return Math.round((asUtc - truncatedSec) / 60000);
  }

  function daysBetweenPlain(isoA, isoB) {
    const sA = String(isoA || '').slice(0, 10);
    const sB = String(isoB || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sA) || !/^\d{4}-\d{2}-\d{2}$/.test(sB)) return NaN;
    if (typeof globalThis.Temporal !== 'undefined') {
      const a = globalThis.Temporal.PlainDate.from(sA);
      const b = globalThis.Temporal.PlainDate.from(sB);
      return b.until(a, { largestUnit: 'days' }).days;
    }
    const [y1, m1, d1] = sA.split('-').map(Number);
    const [y2, m2, d2] = sB.split('-').map(Number);
    return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
  }

  function addPlainDate(isoStr, { days = 0, months = 0, years = 0 } = {}) {
    const s = String(isoStr || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    if (typeof globalThis.Temporal !== 'undefined') {
      return globalThis.Temporal.PlainDate.from(s)
        .add({ days, months, years }, { overflow: 'constrain' })
        .toString();
    }
    const [y, m, d] = s.split('-').map(Number);
    const totalMonths = y * 12 + (m - 1) + years * 12 + months;
    const targetY = Math.floor(totalMonths / 12);
    const targetM = ((totalMonths % 12) + 12) % 12;
    const maxDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
    const clampedD = Math.min(d, maxDay);
    const dt = new Date(Date.UTC(targetY, targetM, clampedD + days));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }

  function daysInMonth(year, month) {
    if (typeof globalThis.Temporal !== 'undefined') {
      return globalThis.Temporal.PlainYearMonth.from({ year, month, calendar: 'iso8601' }).daysInMonth;
    }
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function dayOfWeekSun0(year, month, day) {
    if (typeof globalThis.Temporal !== 'undefined') {
      return globalThis.Temporal.PlainDate.from({ year, month, day }).dayOfWeek % 7;
    }
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  function formatPlainDateDisplay(isoDate, { era = activeEra, short = false } = {}) {
    const s = String(isoDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    const loc = localeForEra(era);
    if (typeof globalThis.Temporal !== 'undefined') {
      const pd = globalThis.Temporal.PlainDate.from(s);
      return pd.toLocaleString(loc, {
        day: 'numeric',
        month: short ? 'short' : 'long',
        year: 'numeric'
      });
    }
    const [y, m, d] = s.split('-').map(Number);
    // Display location-agnostic calendar date without local zone shift by anchoring noon UTC and formatting UTC
    return new Intl.DateTimeFormat(loc, {
      timeZone: 'UTC',
      day: 'numeric',
      month: short ? 'short' : 'long',
      year: 'numeric'
    }).format(Date.UTC(y, m - 1, d, 12, 0, 0));
  }

  function nowZoned(tz = activeTz, era = activeEra) {
    const zone = isValidTimeZone(tz) ? tz : activeTz;
    const loc = localeForEra(era);
    if (typeof globalThis.Temporal !== 'undefined') {
      const zdt = globalThis.Temporal.Now.zonedDateTimeISO(zone);
      return {
        year: zdt.year,
        month: zdt.month,
        day: zdt.day,
        hour: zdt.hour,
        minute: zdt.minute,
        second: zdt.second,
        isoDate: zdt.toPlainDate().toString(),
        isoMinute: `${zdt.toPlainDate().toString()}T${pad2(zdt.hour)}:${pad2(zdt.minute)}`,
        isoFull: `${zdt.toPlainDate().toString()}T${pad2(zdt.hour)}:${pad2(zdt.minute)}:${pad2(zdt.second)}${zdt.offset}`,
        offset: zdt.offset,
        offsetShort: intlOffsetLabel(zdt.epochMilliseconds, zone),
        tz: zone,
        epochMs: zdt.epochMilliseconds,
        weekdayText: zdt.toLocaleString(loc, { weekday: 'long' }),
        dateText: zdt.toLocaleString(loc, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        }),
        timeText: zdt.toLocaleString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        })
      };
    }

    const epochMs = Date.now();
    const p = intlPartsForEpoch(epochMs, zone);
    const offMins = computeIntlOffsetMinutes(epochMs, zone);
    const offset = offsetMinutesToIso(offMins);
    const isoDate = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    return {
      year: p.year,
      month: p.month,
      day: p.day,
      hour: p.hour,
      minute: p.minute,
      second: p.second,
      isoDate,
      isoMinute: `${isoDate}T${pad2(p.hour)}:${pad2(p.minute)}`,
      isoFull: `${isoDate}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${offset}`,
      offset,
      offsetShort: intlOffsetLabel(epochMs, zone),
      tz: zone,
      epochMs,
      weekdayText: new Intl.DateTimeFormat(loc, { timeZone: zone, weekday: 'long' }).format(epochMs),
      dateText: new Intl.DateTimeFormat(loc, {
        timeZone: zone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }).format(epochMs),
      timeText: new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(epochMs)
    };
  }

  function normalizeInstantString(ts) {
    const raw = String(ts || '').trim();
    if (!raw) return '';
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return raw;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00Z`;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return `${raw}:00+07:00`;
    return raw;
  }

  function instantToTzParts(isoTimestamp, tz = activeTz, era = activeEra) {
    const zone = isValidTimeZone(tz) ? tz : activeTz;
    const loc = localeForEra(era);
    const norm = normalizeInstantString(isoTimestamp);
    if (!norm) return null;

    if (typeof globalThis.Temporal !== 'undefined') {
      try {
        const inst = globalThis.Temporal.Instant.from(norm);
        const zdt = inst.toZonedDateTimeISO(zone);
        const isoDate = zdt.toPlainDate().toString();
        const hm = `${pad2(zdt.hour)}:${pad2(zdt.minute)}`;
        return {
          isoDate,
          isoMinute: `${isoDate}T${hm}`,
          offset: zdt.offset,
          epochMs: zdt.epochMilliseconds,
          displayDate: zdt.toLocaleString(loc, {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          }),
          displayTime: zdt.toLocaleString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }),
          displayDateTime: `${zdt.toLocaleString(loc, {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          })} ${zdt.toLocaleString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          })}`
        };
      } catch {
        return null;
      }
    }

    const epochMs = Date.parse(norm);
    if (!Number.isFinite(epochMs)) return null;
    const p = intlPartsForEpoch(epochMs, zone);
    const offMins = computeIntlOffsetMinutes(epochMs, zone);
    const isoDate = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    const displayDate = new Intl.DateTimeFormat(loc, {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(epochMs);
    const displayTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(epochMs);
    return {
      isoDate,
      isoMinute: `${isoDate}T${pad2(p.hour)}:${pad2(p.minute)}`,
      offset: offsetMinutesToIso(offMins),
      epochMs,
      displayDate,
      displayTime,
      displayDateTime: `${displayDate} ${displayTime}`
    };
  }

  function formatInstantInTz(isoTimestamp, tz = activeTz, { includeSeconds = false, era = activeEra } = {}) {
    const zone = isValidTimeZone(tz) ? tz : activeTz;
    const loc = localeForEra(era);
    const norm = normalizeInstantString(isoTimestamp);
    if (!norm) return '';

    if (typeof globalThis.Temporal !== 'undefined') {
      try {
        const zdt = globalThis.Temporal.Instant.from(norm).toZonedDateTimeISO(zone);
        const datePart = zdt.toLocaleString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
        const timePart = zdt.toLocaleString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          ...(includeSeconds ? { second: '2-digit' } : {}),
          hour12: false
        });
        return `${datePart} ${timePart}`;
      } catch {}
    }

    const epochMs = Date.parse(norm);
    if (!Number.isFinite(epochMs)) return String(isoTimestamp);
    const datePart = new Intl.DateTimeFormat(loc, {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(epochMs);
    const timePart = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      ...(includeSeconds ? { second: '2-digit' } : {}),
      hour12: false
    }).format(epochMs);
    return `${datePart} ${timePart}`;
  }

  function resolveZonedDateTime(dateStr, timeStr = '00:00', tz = activeTz) {
    const zone = isValidTimeZone(tz) ? tz : activeTz;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
    const [hh = '00', mm = '00'] = String(timeStr || '00:00').split(':');
    const cleanTime = `${pad2(Number(hh))}:${pad2(Number(mm))}`;

    if (typeof globalThis.Temporal !== 'undefined') {
      const inputStr = `${dateStr}T${cleanTime}:00[${zone}]`;
      let hasDstConflict = false;
      try {
        globalThis.Temporal.ZonedDateTime.from(inputStr, { disambiguation: 'reject' });
      } catch (err) {
        if (err instanceof RangeError) hasDstConflict = true;
      }
      const zdt = globalThis.Temporal.ZonedDateTime.from(inputStr, { disambiguation: 'compatible' });
      const resolvedDate = zdt.toPlainDate().toString();
      const resolvedTime = `${pad2(zdt.hour)}:${pad2(zdt.minute)}`;
      const skipped = resolvedDate !== dateStr || resolvedTime !== cleanTime;
      return {
        hasDstConflict,
        warning: hasDstConflict
          ? skipped
            ? `เวลา ${cleanTime} ไม่มีอยู่จริงในช่วงเปลี่ยนเวลา DST ของ ${zone} (ปรับเป็น ${resolvedTime} ${zdt.offset} อัตโนมัติ)`
            : `เวลา ${cleanTime} เกิดซ้ำ 2 รอบช่วงถอยนาฬิกา DST ของ ${zone} (เลือกใช้ ${resolvedTime} ${zdt.offset})`
          : '',
        isoDate: resolvedDate,
        isoMinute: `${resolvedDate}T${resolvedTime}`,
        isoFull: `${resolvedDate}T${resolvedTime}:00${zdt.offset}`,
        offset: zdt.offset,
        epochMs: zdt.epochMilliseconds
      };
    }

    // Pure Intl fallback when Temporal API / polyfill is unavailable
    const [y, m, d] = dateStr.split('-').map(Number);
    const h = Number(hh);
    const min = Number(mm);
    const wallUtc = Date.UTC(y, m - 1, d, h, min, 0);
    const offGuess1 = computeIntlOffsetMinutes(wallUtc, zone);
    const cand1 = wallUtc - offGuess1 * 60000;
    const offGuess2 = computeIntlOffsetMinutes(cand1, zone);
    const epoch1 = wallUtc - offGuess2 * 60000;
    const p1 = intlPartsForEpoch(epoch1, zone);
    const skipped = p1.hour !== h || p1.minute !== min || p1.day !== d;

    // Also test +-1 hour for fall-back ambiguity
    const pBefore = intlPartsForEpoch(epoch1 - 3600000, zone);
    const pAfter = intlPartsForEpoch(epoch1 + 3600000, zone);
    const sameWallBefore = pBefore.hour === h && pBefore.minute === min && pBefore.day === d;
    const sameWallAfter = pAfter.hour === h && pAfter.minute === min && pAfter.day === d;
    const hasDstConflict = skipped || sameWallBefore || sameWallAfter;

    const finalOff = offsetMinutesToIso(computeIntlOffsetMinutes(epoch1, zone));
    const resolvedDate = `${p1.year}-${pad2(p1.month)}-${pad2(p1.day)}`;
    const resolvedTime = `${pad2(p1.hour)}:${pad2(p1.minute)}`;
    return {
      hasDstConflict,
      warning: hasDstConflict
        ? skipped
          ? `เวลา ${cleanTime} ไม่มีอยู่จริงในช่วงเปลี่ยนเวลา DST ของ ${zone} (ปรับเป็น ${resolvedTime} ${finalOff} อัตโนมัติ)`
          : `เวลา ${cleanTime} เกิดซ้ำ 2 รอบช่วงถอยนาฬิกา DST ของ ${zone} (เลือกใช้ ${resolvedTime} ${finalOff})`
        : '',
      isoDate: resolvedDate,
      isoMinute: `${resolvedDate}T${resolvedTime}`,
      isoFull: `${resolvedDate}T${resolvedTime}:00${finalOff}`,
      offset: finalOff,
      epochMs: epoch1
    };
  }

  function getZoneList(filterQuery = '') {
    const detected = getDetectedTimeZone();
    const seen = new Set();
    const list = [];

    if (!CURATED_ZONES.some((z) => z.tz === detected)) {
      seen.add(detected);
      list.push({ tz: detected, label: 'เขตเวลาเครื่องของคุณ (Auto)' });
    }
    for (const item of CURATED_ZONES) {
      if (!seen.has(item.tz)) {
        seen.add(item.tz);
        list.push(item);
      }
    }

    const q = filterQuery.trim().toLowerCase();
    if (q) {
      try {
        if (typeof Intl.supportedValuesOf === 'function') {
          for (const tz of Intl.supportedValuesOf('timeZone')) {
            if (!seen.has(tz) && tz.toLowerCase().includes(q)) {
              seen.add(tz);
              list.push({ tz, label: tz.replace(/_/g, ' ') });
            }
          }
        }
      } catch {}
      return list.filter(
        (z) => z.tz.toLowerCase().includes(q) || z.label.toLowerCase().includes(q)
      ).slice(0, 35);
    }

    return list;
  }

  function renderTzPopoverList() {
    if (!activeTzPopover) return;
    const listEl = activeTzPopover.querySelector('.tz-zone-list');
    if (!listEl) return;
    const zones = getZoneList(activeTzFilterQuery);
    listEl.innerHTML =
      zones
        .map((z) => {
          const zNow = nowZoned(z.tz, activeEra);
          const isCurrent = z.tz === activeTz;
          return `<button type="button" class="tz-zone-item ${isCurrent ? 'active' : ''}" data-pick-tz="${escapeHtml(z.tz)}">
            <span class="tz-zone-name">
              <strong>${escapeHtml(z.tz)}</strong>
              <small>${escapeHtml(z.label)}</small>
            </span>
            <span class="tz-zone-clock tabular">
              <strong>${escapeHtml(zNow.timeText)}</strong>
              <small>${escapeHtml(zNow.offsetShort)} (${escapeHtml(zNow.offset)})</small>
            </span>
          </button>`;
        })
        .join('') || '<div class="dtp-pop-sub">ไม่พบ Timezone ที่ค้นหา</div>';

    listEl.querySelectorAll('[data-pick-tz]').forEach((btn) => {
      btn.onclick = () => {
        setTimeZone(btn.dataset.pickTz);
        try {
          activeTzPopover.hidePopover?.();
        } catch {}
      };
    });
  }

  function renderTickerNow() {
    const info = nowZoned(activeTz, activeEra);
    if (tickerMount?.navClockEl) {
      tickerMount.navClockEl.innerHTML = `
        <span class="nav-clock-dot" aria-hidden="true"></span>
        <span class="tabular">${escapeHtml(info.timeText)}</span>
        <span class="nav-clock-tz">${escapeHtml(info.offsetShort)}</span>
      `;
      tickerMount.navClockEl.title = `${info.tz} (${info.offset}) · ${info.dateText}`;
    }

    if (tickerMount?.containerEl) {
      const card = tickerMount.containerEl;
      const clockEl = card.querySelector('.tz-clock-readout');
      const offsetEl = card.querySelector('.tz-offset-pill');
      const dateEl = card.querySelector('.tz-date-readout');
      const zoneTextEl = card.querySelector('.tz-zone-name-inline');
      const eraBtn = card.querySelector('.tz-era-btn');
      if (clockEl) clockEl.textContent = info.timeText;
      if (offsetEl) offsetEl.textContent = `${info.offsetShort} (${info.offset})`;
      if (dateEl) dateEl.textContent = info.dateText;
      if (zoneTextEl) zoneTextEl.textContent = `IANA: ${info.tz}`;
      if (eraBtn) eraBtn.textContent = activeEra === 'be' ? 'พ.ศ. / ค.ศ.' : 'ค.ศ. / พ.ศ.';
    }

    if (activeTzPopover && activeTzPopover.matches(':popover-open, .\\:popover-open')) {
      activeTzPopover.querySelectorAll('[data-pick-tz]').forEach((btn) => {
        const tz = btn.dataset.pickTz;
        const zNow = nowZoned(tz, activeEra);
        const timeStrong = btn.querySelector('.tz-zone-clock strong');
        if (timeStrong) timeStrong.textContent = zNow.timeText;
      });
    }
  }

  function startTickerLoop() {
    if (tickerTimer) clearTimeout(tickerTimer);
    renderTickerNow();
    const delay = 1005 - (Date.now() % 1000);
    tickerTimer = setTimeout(startTickerLoop, delay);
  }

  function mountTimeTicker(containerEl, { navClockEl = null } = {}) {
    if (!containerEl) return;
    const popId = nextId('tz-popover');
    containerEl.innerHTML = `
      <div class="tz-ticker-card" aria-label="นาฬิกาเรียลไทม์และ Timezone">
        <div class="tz-ticker-top">
          <span class="tz-ticker-label">
            <span class="tz-ticker-dot" aria-hidden="true"></span>
            Live Time Ticker
          </span>
          <div class="tz-ticker-actions">
            <button type="button" class="tz-era-btn" id="${popId}-era" title="สลับการแสดงผล พ.ศ. / ค.ศ.">
              พ.ศ. / ค.ศ.
            </button>
            <button type="button" class="tz-trigger-btn" popovertarget="${popId}">
              เปลี่ยนโซนเวลา
            </button>
          </div>
        </div>
        <div class="tz-ticker-main">
          <div class="tz-clock-readout tabular">--:--:--</div>
          <span class="tz-offset-pill tabular">GMT+7</span>
        </div>
        <div class="tz-date-readout">กำลังตรวจสอบเวลา…</div>
        <div class="tz-zone-meta">
          <span class="tz-zone-name-inline">IANA: ${escapeHtml(activeTz)}</span>
          <span>ซิงก์ Log ข้ามเขตเวลาอัตโนมัติ</span>
        </div>
        <div id="${popId}" popover="auto" class="tz-popover" aria-label="เลือก Timezone">
          <div class="dtp-pop-head">
            <div>
              <div class="dtp-pop-title">เลือกโซนเวลา (IANA Timezone)</div>
              <div class="dtp-pop-sub">เวลาหน้าปัดและประวัติจ่ายยาจะแปลงตามโซนที่เลือก</div>
            </div>
            <button type="button" class="dtp-close-btn" popovertarget="${popId}" popovertargetaction="hide">ปิด</button>
          </div>
          <input type="search" class="tz-search-input" placeholder="ค้นหา เช่น Bangkok, Tokyo, New_York, UTC…" aria-label="ค้นหา Timezone" />
          <div class="tz-zone-list"></div>
        </div>
      </div>
    `;

    activeTzPopover = containerEl.querySelector(`#${popId}`);
    const searchInput = activeTzPopover.querySelector('.tz-search-input');
    searchInput.addEventListener('input', () => {
      activeTzFilterQuery = searchInput.value;
      renderTzPopoverList();
    });

    activeTzPopover.addEventListener('toggle', (ev) => {
      if (ev.newState === 'open') {
        activeTzFilterQuery = '';
        searchInput.value = '';
        renderTzPopoverList();
        setTimeout(() => searchInput.focus(), 20);
      }
    });

    containerEl.querySelector(`#${popId}-era`).onclick = () => {
      setEra(activeEra === 'be' ? 'ce' : 'be');
    };

    tickerMount = { containerEl, navClockEl };
    startTickerLoop();
  }

  function parseInputState(valueStr, mode) {
    const v = String(valueStr || '').trim();
    if (!v) return { date: '', hour: 9, minute: 0 };

    if (mode === 'datetime-iso') {
      const p = instantToTzParts(v, activeTz, activeEra);
      if (p) {
        const [, hm = '09:00'] = p.isoMinute.split('T');
        const [hh, mm] = hm.split(':').map(Number);
        return { date: p.isoDate, hour: hh, minute: mm };
      }
    }

    const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) {
      return {
        date: m[1],
        hour: m[2] !== undefined ? Number(m[2]) : 9,
        minute: m[3] !== undefined ? Number(m[3]) : 0
      };
    }
    return { date: '', hour: 9, minute: 0 };
  }

  function formatDisplayValue(inputEl, mode) {
    const raw = String(inputEl.value || '').trim();
    if (!raw) return '';
    if (mode === 'date' || mode === 'date-expiry') {
      return formatPlainDateDisplay(raw, { era: activeEra, short: true });
    }
    if (mode === 'datetime-iso') {
      return formatInstantInTz(raw, activeTz, { includeSeconds: false, era: activeEra });
    }
    const parsed = parseInputState(raw, 'datetime');
    if (!parsed.date) return raw;
    const dText = formatPlainDateDisplay(parsed.date, { era: activeEra, short: true });
    return `${dText} · ${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
  }

  function enhanceInput(inputEl, options = {}) {
    if (!inputEl) return null;
    const mode = options.mode || inputEl.dataset.dtp || (inputEl.type === 'datetime-local' ? 'datetime' : 'date');
    const snapshotDate = options.snapshotDate || inputEl.dataset.dtpSnapshot || '';
    const rangeStartId = options.rangeStart || inputEl.dataset.dtpRangeStart || '';
    const rangeEndId = options.rangeEnd || inputEl.dataset.dtpRangeEnd || '';
    const placeholder = options.placeholder || inputEl.getAttribute('placeholder') || (mode.includes('datetime') ? 'เลือกวันและเวลา…' : 'เลือกวันที่…');

    if (enhancedFields.has(inputEl)) {
      const ctx = enhancedFields.get(inputEl);
      ctx.options = { mode, snapshotDate, rangeStartId, rangeEndId, placeholder };
      ctx.sync();
      return ctx;
    }

    const popId = nextId('dtp-pop');
    const hasTime = mode === 'datetime' || mode === 'datetime-iso';

    const wrapper = document.createElement('div');
    wrapper.className = 'dtp-field';
    inputEl.parentNode.insertBefore(wrapper, inputEl);
    wrapper.appendChild(inputEl);
    inputEl.classList.add('dtp-native-hidden');
    inputEl.tabIndex = -1;
    inputEl.setAttribute('aria-hidden', 'true');

    const triggerWrap = document.createElement('div');
    triggerWrap.className = 'dtp-trigger-wrap';
    triggerWrap.innerHTML = `
      <button type="button" class="dtp-trigger is-placeholder" popovertarget="${popId}">
        <span class="dtp-display-text"></span>
        ${hasTime ? `<span class="dtp-zone-tag"></span>` : ''}
      </button>
      <button type="button" class="dtp-clear-btn hide" aria-label="ล้างค่าวันที่">×</button>
      <span class="dtp-trigger-icons" aria-hidden="true">
        <span class="dtp-icon-cal">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
        </span>
      </span>
    `;
    wrapper.appendChild(triggerWrap);

    const popoverEl = document.createElement('div');
    popoverEl.id = popId;
    popoverEl.setAttribute('popover', 'auto');
    popoverEl.className = 'dtp-popover';
    popoverEl.setAttribute('aria-label', hasTime ? 'ตัวเลือกวันที่และเวลา' : 'ตัวเลือกวันที่');
    wrapper.appendChild(popoverEl);

    const triggerBtn = triggerWrap.querySelector('.dtp-trigger');
    const clearBtn = triggerWrap.querySelector('.dtp-clear-btn');
    const displayTextEl = triggerBtn.querySelector('.dtp-display-text');
    const zoneTagEl = triggerBtn.querySelector('.dtp-zone-tag');

    // Sync accessible label from input's <label for="...">
    const linkedLabel = inputEl.id ? document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`) : null;
    if (linkedLabel) {
      triggerBtn.setAttribute('aria-label', linkedLabel.textContent.trim());
    }

    const viewState = {
      viewYear: 2026,
      viewMonth: 11,
      selDate: '',
      hour: 9,
      minute: 0
    };

    const ctx = {
      options: { mode, snapshotDate, rangeStartId, rangeEndId, placeholder },
      sync() {
        const display = formatDisplayValue(inputEl, ctx.options.mode);
        displayTextEl.textContent = display || ctx.options.placeholder;
        triggerBtn.classList.toggle('is-placeholder', !display);
        triggerBtn.classList.toggle('is-filtered', inputEl.classList.contains('is-filtered'));
        triggerBtn.classList.toggle('is-invalid', inputEl.classList.contains('is-invalid'));
        clearBtn.classList.toggle('hide', !inputEl.value);
        if (zoneTagEl) {
          zoneTagEl.textContent = nowZoned(activeTz, activeEra).offsetShort;
        }
        if (popoverEl.matches(':popover-open, .\\:popover-open')) {
          renderPopover();
        }
      }
    };

    function commitValue(nextDate, nextHour, nextMin, { closeAfter = false } = {}) {
      let outVal = '';
      if (nextDate) {
        if (ctx.options.mode === 'datetime') {
          outVal = `${nextDate}T${pad2(nextHour)}:${pad2(nextMin)}`;
        } else if (ctx.options.mode === 'datetime-iso') {
          const resolved = resolveZonedDateTime(nextDate, `${pad2(nextHour)}:${pad2(nextMin)}`, activeTz);
          outVal = resolved ? resolved.isoFull : `${nextDate}T${pad2(nextHour)}:${pad2(nextMin)}:00+07:00`;
        } else {
          outVal = nextDate;
        }
      }
      viewState.selDate = nextDate;
      viewState.hour = nextHour;
      viewState.minute = nextMin;
      inputEl.value = outVal;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      ctx.sync();
      if (closeAfter) {
        try {
          popoverEl.hidePopover?.();
        } catch {}
      }
    }

    function renderPopover() {
      const m = ctx.options.mode;
      const isDateTime = m === 'datetime' || m === 'datetime-iso';
      const zNow = nowZoned(activeTz, activeEra);
      const todayIso = zNow.isoDate;
      const rangeStartVal = ctx.options.rangeStartId
        ? document.getElementById(ctx.options.rangeStartId)?.value?.slice(0, 10) || ''
        : '';
      const rangeEndVal = ctx.options.rangeEndId
        ? document.getElementById(ctx.options.rangeEndId)?.value?.slice(0, 10) || ''
        : '';

      const firstDow = dayOfWeekSun0(viewState.viewYear, viewState.viewMonth, 1);
      const totalDays = daysInMonth(viewState.viewYear, viewState.viewMonth);
      const prevMonth = viewState.viewMonth === 1 ? 12 : viewState.viewMonth - 1;
      const prevYear = viewState.viewMonth === 1 ? viewState.viewYear - 1 : viewState.viewYear;
      const prevTotal = daysInMonth(prevYear, prevMonth);

      const cells = [];
      for (let i = firstDow - 1; i >= 0; i--) {
        const d = prevTotal - i;
        cells.push({
          y: prevYear,
          m: prevMonth,
          d,
          iso: `${prevYear}-${pad2(prevMonth)}-${pad2(d)}`,
          outside: true
        });
      }
      for (let d = 1; d <= totalDays; d++) {
        cells.push({
          y: viewState.viewYear,
          m: viewState.viewMonth,
          d,
          iso: `${viewState.viewYear}-${pad2(viewState.viewMonth)}-${pad2(d)}`,
          outside: false
        });
      }
      const nextMonth = viewState.viewMonth === 12 ? 1 : viewState.viewMonth + 1;
      const nextYear = viewState.viewMonth === 12 ? viewState.viewYear + 1 : viewState.viewYear;
      let trailing = 1;
      while (cells.length < 42) {
        cells.push({
          y: nextYear,
          m: nextMonth,
          d: trailing,
          iso: `${nextYear}-${pad2(nextMonth)}-${pad2(trailing)}`,
          outside: true
        });
        trailing++;
      }

      const eraOffset = activeEra === 'be' ? 543 : 0;
      const minY = Math.min(viewState.viewYear, 2020);
      const maxY = Math.max(viewState.viewYear, 2032);
      const yearOptions = [];
      for (let y = minY; y <= maxY; y++) {
        yearOptions.push(
          `<option value="${y}" ${y === viewState.viewYear ? 'selected' : ''}>${y + eraOffset}</option>`
        );
      }

      const monthOptions = TH_MONTHS_LONG.map(
        (name, idx) =>
          `<option value="${idx + 1}" ${idx + 1 === viewState.viewMonth ? 'selected' : ''}>${name}</option>`
      ).join('');

      const presetsHtml =
        m === 'date-expiry'
          ? `
            <button type="button" class="dtp-preset-btn" data-preset="p6m">+6 เดือน</button>
            <button type="button" class="dtp-preset-btn" data-preset="p1y">+1 ปี</button>
            <button type="button" class="dtp-preset-btn" data-preset="p2y">+2 ปี</button>
            <button type="button" class="dtp-preset-btn" data-preset="clear">ไม่ทราบวัน</button>
          `
          : `
            <button type="button" class="dtp-preset-btn" data-preset="today">วันนี้ (${escapeHtml(zNow.offsetShort)})</button>
            <button type="button" class="dtp-preset-btn" data-preset="yesterday">เมื่อวาน</button>
            ${ctx.options.snapshotDate ? `<button type="button" class="dtp-preset-btn" data-preset="snapshot">วัน Snapshot</button>` : ''}
            ${isDateTime ? `<button type="button" class="dtp-preset-btn" data-preset="now">ตอนนี้</button>` : ''}
            <button type="button" class="dtp-preset-btn" data-preset="clear">ล้างค่า</button>
          `;

      let timeHtml = '';
      if (isDateTime) {
        const previewDate = viewState.selDate || ctx.options.snapshotDate || todayIso;
        const previewTime = `${pad2(viewState.hour)}:${pad2(viewState.minute)}`;
        const dstCheck = resolveZonedDateTime(previewDate, previewTime, activeTz);
        const slots = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'];

        timeHtml = `
          <div class="dtp-time-panel">
            <div class="dtp-time-head">
              <span class="dtp-pop-title">เวลา (${escapeHtml(activeTz)})</span>
              <span class="dtp-pop-sub tabular">${escapeHtml(dstCheck?.offset || zNow.offset)}</span>
            </div>
            <div class="dtp-time-steppers">
              <div class="dtp-stepper-col">
                <small>ชั่วโมง (24h)</small>
                <div class="dtp-stepper-ctrl">
                  <button type="button" class="dtp-step-btn" data-step="h-" aria-label="ลดชั่วโมง">−</button>
                  <input type="text" inputmode="numeric" maxlength="2" class="dtp-step-num dtp-hour-input tabular" value="${pad2(viewState.hour)}" aria-label="ชั่วโมง" />
                  <button type="button" class="dtp-step-btn" data-step="h+" aria-label="เพิ่มชั่วโมง">+</button>
                </div>
              </div>
              <div class="dtp-time-colon">:</div>
              <div class="dtp-stepper-col">
                <small>นาที</small>
                <div class="dtp-stepper-ctrl">
                  <button type="button" class="dtp-step-btn" data-step="m-" aria-label="ลดนาที">−</button>
                  <input type="text" inputmode="numeric" maxlength="2" class="dtp-step-num dtp-min-input tabular" value="${pad2(viewState.minute)}" aria-label="นาที" />
                  <button type="button" class="dtp-step-btn" data-step="m+" aria-label="เพิ่มนาที">+</button>
                </div>
              </div>
            </div>
            <div class="dtp-shift-slots" role="group" aria-label="ช่วงเวลาด่วน">
              ${slots
                .map(
                  (sl) =>
                    `<button type="button" class="dtp-slot-btn tabular ${sl === previewTime ? 'active' : ''}" data-slot="${sl}">${sl}</button>`
                )
                .join('')}
            </div>
            ${dstCheck?.hasDstConflict ? `<div class="dtp-dst-warn" role="status">${escapeHtml(dstCheck.warning)}</div>` : ''}
          </div>
        `;
      }

      popoverEl.innerHTML = `
        <div class="dtp-pop-head">
          <div>
            <div class="dtp-pop-title">${isDateTime ? 'เลือกวันและเวลา' : 'เลือกวันที่ปฏิทิน'}</div>
            <div class="dtp-pop-sub">Timezone: ${escapeHtml(activeTz)} (${escapeHtml(zNow.offset)})</div>
          </div>
          <button type="button" class="dtp-close-btn" data-dtp-close>ปิด</button>
        </div>
        <div class="dtp-cal-nav">
          <button type="button" class="dtp-nav-btn" data-nav="-1" aria-label="เดือนก่อนหน้า">‹</button>
          <div class="dtp-month-selects">
            <select class="dtp-mini-select dtp-month-sel" aria-label="เลือกเดือน">${monthOptions}</select>
            <select class="dtp-mini-select dtp-year-sel" aria-label="เลือกปี">${yearOptions.join('')}</select>
          </div>
          <button type="button" class="dtp-nav-btn" data-nav="1" aria-label="เดือนถัดไป">›</button>
        </div>
        <div class="dtp-weekdays" aria-hidden="true">
          ${TH_WEEKDAYS_SHORT.map((w) => `<div class="dtp-weekday">${w}</div>`).join('')}
        </div>
        <div class="dtp-cal-grid" role="grid" aria-label="ตารางวันในเดือน">
          ${cells
            .map((c) => {
              const isSelected = viewState.selDate === c.iso;
              const isToday = c.iso === todayIso;
              const lo = viewState.selDate && rangeStartVal ? rangeStartVal : '';
              const hi = viewState.selDate && rangeEndVal ? rangeEndVal : '';
              const inRange =
                !isSelected &&
                ((lo && viewState.selDate && c.iso > lo && c.iso < viewState.selDate) ||
                  (hi && viewState.selDate && c.iso > viewState.selDate && c.iso < hi));
              const cls = [
                'dtp-day',
                'tabular',
                c.outside ? 'is-outside' : '',
                isToday ? 'is-today' : '',
                inRange ? 'is-in-range' : '',
                isSelected ? 'is-selected' : ''
              ]
                .filter(Boolean)
                .join(' ');
              return `<button type="button" class="${cls}" data-iso="${c.iso}" aria-pressed="${isSelected}">${c.d}</button>`;
            })
            .join('')}
        </div>
        <div class="dtp-presets">${presetsHtml}</div>
        ${timeHtml}
        <div class="dtp-pop-foot">
          <span class="dtp-zone-foot">ระบบ ${activeEra === 'be' ? 'พ.ศ.' : 'ค.ศ.'}</span>
          ${isDateTime ? `<button type="button" class="dtp-apply-btn">ตกลง</button>` : ''}
        </div>
      `;

      // Bind popover events
      popoverEl.querySelector('[data-dtp-close]').onclick = () => {
        try {
          popoverEl.hidePopover?.();
        } catch {}
      };

      popoverEl.querySelectorAll('[data-nav]').forEach((b) => {
        b.onclick = () => {
          const delta = Number(b.dataset.nav);
          let nextM = viewState.viewMonth + delta;
          let nextY = viewState.viewYear;
          if (nextM < 1) {
            nextM = 12;
            nextY -= 1;
          } else if (nextM > 12) {
            nextM = 1;
            nextY += 1;
          }
          viewState.viewMonth = nextM;
          viewState.viewYear = nextY;
          renderPopover();
        };
      });

      popoverEl.querySelector('.dtp-month-sel').onchange = (e) => {
        viewState.viewMonth = Number(e.target.value);
        renderPopover();
      };
      popoverEl.querySelector('.dtp-year-sel').onchange = (e) => {
        viewState.viewYear = Number(e.target.value);
        renderPopover();
      };

      popoverEl.querySelectorAll('.dtp-day').forEach((btn) => {
        btn.onclick = () => {
          const isoDate = btn.dataset.iso;
          const [y, mm] = isoDate.split('-').map(Number);
          viewState.viewYear = y;
          viewState.viewMonth = mm;
          commitValue(isoDate, viewState.hour, viewState.minute, { closeAfter: !isDateTime });
          if (isDateTime) renderPopover();
        };

        btn.onkeydown = (e) => {
          const move = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -7,
            ArrowDown: 7
          }[e.key];
          if (!move) return;
          e.preventDefault();
          const targetIso = addPlainDate(btn.dataset.iso, { days: move });
          const [ty, tm] = targetIso.split('-').map(Number);
          viewState.viewYear = ty;
          viewState.viewMonth = tm;
          renderPopover();
          popoverEl.querySelector(`.dtp-day[data-iso="${targetIso}"]`)?.focus();
        };
      });

      popoverEl.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.onclick = () => {
          const kind = btn.dataset.preset;
          const nowInfo = nowZoned(activeTz, activeEra);
          if (kind === 'clear') {
            commitValue('', 9, 0, { closeAfter: true });
            return;
          }
          if (kind === 'now') {
            const [y, mm] = nowInfo.isoDate.split('-').map(Number);
            viewState.viewYear = y;
            viewState.viewMonth = mm;
            commitValue(nowInfo.isoDate, nowInfo.hour, nowInfo.minute, { closeAfter: false });
            renderPopover();
            return;
          }
          let targetIso = nowInfo.isoDate;
          if (kind === 'yesterday') targetIso = addPlainDate(nowInfo.isoDate, { days: -1 });
          else if (kind === 'snapshot' && ctx.options.snapshotDate) targetIso = ctx.options.snapshotDate;
          else if (kind === 'p6m') targetIso = addPlainDate(viewState.selDate || ctx.options.snapshotDate || nowInfo.isoDate, { months: 6 });
          else if (kind === 'p1y') targetIso = addPlainDate(viewState.selDate || ctx.options.snapshotDate || nowInfo.isoDate, { years: 1 });
          else if (kind === 'p2y') targetIso = addPlainDate(viewState.selDate || ctx.options.snapshotDate || nowInfo.isoDate, { years: 2 });

          const [ty, tm] = targetIso.split('-').map(Number);
          viewState.viewYear = ty;
          viewState.viewMonth = tm;
          commitValue(targetIso, viewState.hour, viewState.minute, { closeAfter: !isDateTime });
          if (isDateTime) renderPopover();
        };
      });

      if (isDateTime) {
        const ensureDate = () => viewState.selDate || ctx.options.snapshotDate || todayIso;

        popoverEl.querySelectorAll('[data-step]').forEach((btn) => {
          btn.onclick = () => {
            const code = btn.dataset.step;
            let nh = viewState.hour;
            let nm = viewState.minute;
            if (code === 'h+') nh = (nh + 1) % 24;
            if (code === 'h-') nh = (nh + 23) % 24;
            if (code === 'm+') nm = (nm + 5) % 60;
            if (code === 'm-') nm = (nm + 55) % 60;
            commitValue(ensureDate(), nh, nm, { closeAfter: false });
            renderPopover();
          };
        });

        const hInp = popoverEl.querySelector('.dtp-hour-input');
        const mInp = popoverEl.querySelector('.dtp-min-input');
        hInp.onchange = () => {
          const val = Math.max(0, Math.min(23, parseInt(hInp.value, 10) || 0));
          commitValue(ensureDate(), val, viewState.minute, { closeAfter: false });
          renderPopover();
        };
        mInp.onchange = () => {
          const val = Math.max(0, Math.min(59, parseInt(mInp.value, 10) || 0));
          commitValue(ensureDate(), viewState.hour, val, { closeAfter: false });
          renderPopover();
        };

        popoverEl.querySelectorAll('[data-slot]').forEach((btn) => {
          btn.onclick = () => {
            const [sh, sm] = btn.dataset.slot.split(':').map(Number);
            commitValue(ensureDate(), sh, sm, { closeAfter: false });
            renderPopover();
          };
        });

        popoverEl.querySelector('.dtp-apply-btn').onclick = () => {
          try {
            popoverEl.hidePopover?.();
          } catch {}
        };
      }
    }

    popoverEl.addEventListener('toggle', (ev) => {
      if (ev.newState === 'open') {
        const parsed = parseInputState(inputEl.value, ctx.options.mode);
        const anchor = parsed.date || ctx.options.snapshotDate || nowZoned(activeTz, activeEra).isoDate;
        const [y, mm] = anchor.split('-').map(Number);
        viewState.viewYear = y || 2026;
        viewState.viewMonth = mm || 11;
        viewState.selDate = parsed.date;
        viewState.hour = parsed.hour;
        viewState.minute = parsed.minute;
        renderPopover();
      }
    });

    clearBtn.onclick = (e) => {
      e.stopPropagation();
      commitValue('', 9, 0, { closeAfter: true });
    };

    if (typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(() => ctx.sync());
      obs.observe(inputEl, { attributes: true, attributeFilter: ['class', 'value'] });
    }

    enhancedFields.set(inputEl, ctx);
    ctx.sync();
    return ctx;
  }

  function enhanceContainer(rootEl, opts = {}) {
    if (!rootEl) return;
    rootEl.querySelectorAll('[data-dtp]').forEach((el) => {
      enhanceInput(el, {
        mode: el.dataset.dtp,
        snapshotDate: opts.snapshotDate || el.dataset.dtpSnapshot || '',
        rangeStart: el.dataset.dtpRangeStart || '',
        rangeEnd: el.dataset.dtpRangeEnd || ''
      });
    });
  }

  function syncInput(inputEl) {
    const ctx = enhancedFields.get(inputEl);
    if (ctx) ctx.sync();
  }

  function refreshAllEnhancedFields() {
    for (const [el, ctx] of enhancedFields.entries()) {
      if (!el.isConnected) {
        enhancedFields.delete(el);
        continue;
      }
      ctx.sync();
    }
  }

  global.PharmacyDateTime = {
    getTimeZone: () => activeTz,
    setTimeZone,
    getEra: () => activeEra,
    setEra,
    getDetectedTimeZone,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    daysBetweenPlain,
    addPlainDate,
    nowZoned,
    instantToTzParts,
    formatInstantInTz,
    formatPlainDateDisplay,
    resolveZonedDateTime,
    mountTimeTicker,
    enhanceInput,
    enhanceContainer,
    syncInput,
    refreshAll: refreshAllEnhancedFields
  };
})(window);
