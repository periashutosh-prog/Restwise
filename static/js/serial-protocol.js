/* RWBIN v1 — Restwise's compact binary schedule protocol for the ESP32 watch.
 *
 * [0xA5 0x5A]              sync marker (not covered by CRC)
 * [u8  version]              = 1
 * [u16 LE block_count]
 *   repeated block_count times:
 *     [u8  type]             see RWBIN_TYPE_CODES
 *     [u8  days_bitmask]     bit0=Mon .. bit6=Sun
 *     [u16 LE start_min]     minutes since midnight (0-1439)
 *     [u16 LE end_min]
 *     [u8  label_len]
 *     [label_len bytes]      ASCII label, not null-terminated
 * [u16 LE crc16]             CRC-16/CCITT-FALSE over version..last label byte
 */
(function (global) {
  "use strict";

  var RWBIN_VERSION = 1;
  var SYNC_BYTES = [0xa5, 0x5a];

  var RWBIN_TYPE_CODES = {
    school: 0,
    tuition: 1,
    homework: 2,
    meal: 3,
    break: 4,
    sleep: 5,
    free: 6,
    travel: 7
  };

  var DAY_BITS = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

  function daysToBitmask(days) {
    if (!Array.isArray(days) || days.length === 0) return 0b1111111; // no days array = every day
    var mask = 0;
    days.forEach(function (d) {
      var bit = DAY_BITS[String(d).toLowerCase()];
      if (bit !== undefined) mask |= 1 << bit;
    });
    return mask;
  }

  function timeToMinutes(t) {
    var parts = (t || "00:00").split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || "0", 10);
  }

  function crc16ccitt(bytes) {
    var crc = 0xffff;
    for (var i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (var b = 0; b < 8; b++) {
        crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
        crc &= 0xffff;
      }
    }
    return crc;
  }

  function encodeTimetableBinary(blocks) {
    var encoder = new TextEncoder();
    var recordChunks = [];

    blocks.forEach(function (block) {
      var typeCode = RWBIN_TYPE_CODES[(block.type || "free").toLowerCase()];
      if (typeCode === undefined) typeCode = RWBIN_TYPE_CODES.free;

      var labelBytes = encoder.encode((block.label || "").slice(0, 63));
      var rec = new Uint8Array(1 + 1 + 2 + 2 + 1 + labelBytes.length);
      var view = new DataView(rec.buffer);
      var o = 0;

      view.setUint8(o, typeCode); o += 1;
      view.setUint8(o, daysToBitmask(block.days)); o += 1;
      view.setUint16(o, timeToMinutes(block.start), true); o += 2;
      view.setUint16(o, timeToMinutes(block.end), true); o += 2;
      view.setUint8(o, labelBytes.length); o += 1;
      rec.set(labelBytes, o);

      recordChunks.push(rec);
    });

    var payloadLen = 1 + 2 + recordChunks.reduce(function (sum, r) { return sum + r.length; }, 0);
    var payload = new Uint8Array(payloadLen);
    var pv = new DataView(payload.buffer);
    var po = 0;

    pv.setUint8(po, RWBIN_VERSION); po += 1;
    pv.setUint16(po, blocks.length, true); po += 2;
    recordChunks.forEach(function (r) {
      payload.set(r, po);
      po += r.length;
    });

    var crc = crc16ccitt(payload);

    var frame = new Uint8Array(SYNC_BYTES.length + payload.length + 2);
    frame.set(SYNC_BYTES, 0);
    frame.set(payload, SYNC_BYTES.length);
    var crcView = new DataView(frame.buffer, SYNC_BYTES.length + payload.length, 2);
    crcView.setUint16(0, crc, true);

    return frame;
  }

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  }

  global.RestwiseProtocol = {
    RWBIN_VERSION: RWBIN_VERSION,
    encodeTimetableBinary: encodeTimetableBinary,
    bytesToBase64: bytesToBase64
  };
})(window);
