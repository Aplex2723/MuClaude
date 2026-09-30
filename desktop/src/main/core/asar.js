'use strict';
// Minimal asar reader/writer (port of app/core/asar.py) + Electron fuse flip.
// Layout: [u32 4][u32 header_pickle_size] then a pickle holding
// [u32 payload_size][i32 json_len][json][pad to 4], then file data. Each file
// entry's "offset" is relative to the end of the header.

const crypto = require('crypto');
const fs = require('fs');

const BLOCK_SIZE = 4 * 1024 * 1024;

class AsarArchive {
  constructor(file) {
    this.path = file;
    const fd = fs.openSync(file, 'r');
    try {
      const sizePickle = Buffer.alloc(8);
      fs.readSync(fd, sizePickle, 0, 8, 0);
      const headerSize = sizePickle.readUInt32LE(4);
      const headerPickle = Buffer.alloc(headerSize);
      fs.readSync(fd, headerPickle, 0, headerSize, 8);
      const jsonLen = headerPickle.readInt32LE(4);
      this.header = JSON.parse(headerPickle.subarray(8, 8 + jsonLen).toString('utf8'));
      this.dataOffset = 8 + headerSize;
    } finally { fs.closeSync(fd); }
  }

  * files() {
    function* walk(node, prefix) {
      for (const [name, entry] of Object.entries(node.files)) {
        const p = `${prefix}${name}`;
        if (entry.files) yield* walk(entry, `${p}/`);
        else yield [p, entry];
      }
    }
    yield* walk(this.header, '');
  }

  entry(p) {
    let node = this.header;
    for (const part of p.replace(/^\/+|\/+$/g, '').split('/')) {
      node = node.files && node.files[part];
      if (!node) return null;
    }
    return node;
  }

  read(p) {
    const e = this.entry(p);
    if (!e || e.files || e.link) throw new Error(`not found in asar: ${p}`);
    if (e.unpacked) throw new Error(`${p} is stored in app.asar.unpacked`);
    const fd = fs.openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(Number(e.size));
      fs.readSync(fd, buf, 0, buf.length, this.dataOffset + Number(e.offset));
      return buf;
    } finally { fs.closeSync(fd); }
  }

  /** Copy of the archive at outPath with `replacements` ({path: Buffer}) swapped in. */
  writePatched(outPath, replacements) {
    const header = JSON.parse(JSON.stringify(this.header));
    const dataLen = fs.statSync(this.path).size - this.dataOffset;
    let offset = dataLen;
    for (const [p, data] of Object.entries(replacements)) {
      let node = header;
      for (const part of p.replace(/^\/+|\/+$/g, '').split('/')) {
        node = node.files && node.files[part];
        if (!node) throw new Error(`not found in asar: ${p}`);
      }
      if (node.files || node.link || node.unpacked) throw new Error(`${p} is not a packed file`);
      node.size = data.length;
      node.offset = String(offset);
      if (node.integrity) node.integrity = integrity(data);
      offset += data.length;
    }
    const blob = Buffer.from(JSON.stringify(header), 'utf8');
    const pad = (4 - (blob.length % 4)) % 4;
    const len = Buffer.alloc(4); len.writeInt32LE(blob.length);
    const payload = Buffer.concat([len, blob, Buffer.alloc(pad)]);
    const pl = Buffer.alloc(4); pl.writeUInt32LE(payload.length);
    const headerPickle = Buffer.concat([pl, payload]);
    const lead = Buffer.alloc(8); lead.writeUInt32LE(4, 0); lead.writeUInt32LE(headerPickle.length, 4);

    const src = fs.openSync(this.path, 'r');
    const dst = fs.openSync(outPath, 'w');
    try {
      fs.writeSync(dst, lead); fs.writeSync(dst, headerPickle);
      const chunk = Buffer.alloc(1024 * 1024);
      let pos = this.dataOffset; let left = dataLen;
      while (left > 0) {
        const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, left), pos);
        if (!n) throw new Error('asar archive is truncated');
        fs.writeSync(dst, chunk, 0, n); pos += n; left -= n;
      }
      for (const data of Object.values(replacements)) fs.writeSync(dst, data);
    } finally { fs.closeSync(src); fs.closeSync(dst); }
  }
}

function integrity(data) {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const blocks = [];
  for (let i = 0; i < Math.max(data.length, 1); i += BLOCK_SIZE) blocks.push(sha(data.subarray(i, i + BLOCK_SIZE)));
  return { algorithm: 'SHA256', hash: sha(data), blockSize: BLOCK_SIZE, blocks };
}

// ---- Electron fuses ------------------------------------------------------ //

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const FUSE_ASAR_INTEGRITY = 4; // index into Electron's FuseV1Options

/** Flip one fuse in place. False when the exe has no (unique) fuse wire or fuse. */
function setFuse(exePath, index, enabled) {
  const data = fs.readFileSync(exePath);
  const at = data.indexOf(FUSE_SENTINEL);
  if (at < 0 || data.indexOf(FUSE_SENTINEL, at + 1) >= 0) return false;
  // sentinel, then [version byte][fuse count][one '0'/'1'/'r' byte per fuse]
  const count = data[at + FUSE_SENTINEL.length + 1];
  const pos = at + FUSE_SENTINEL.length + 2 + index;
  if (index >= count || (data[pos] !== 0x30 && data[pos] !== 0x31)) return false;
  data[pos] = enabled ? 0x31 : 0x30;
  const tmp = `${exePath}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, exePath);
  return true;
}

module.exports = { AsarArchive, FUSE_ASAR_INTEGRITY, setFuse, integrity };
