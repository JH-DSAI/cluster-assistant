// node --test web/archive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { extractEntries } from "./archive.js";

const enc = new TextEncoder();

function fakeFile(name, bytes, lastModified = Date.parse("2026-01-01T00:00:00Z")) {
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  return {
    name,
    lastModified,
    async arrayBuffer() {
      return buf;
    },
    async text() {
      return new TextDecoder().decode(buf);
    },
  };
}

function buildTar(files) {
  const blocks = [];
  for (const { name, content, mtime = 0 } of files) {
    const header = new Uint8Array(512);
    header.set(enc.encode(name), 0);
    header.set(enc.encode(content.length.toString(8)), 124);
    header.set(enc.encode(mtime.toString(8)), 136);
    header[156] = "0".charCodeAt(0);
    blocks.push(header);
    const data = enc.encode(content);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  const total = blocks.reduce((t, b) => t + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function buildStoreZip(name, content) {
  const nameBytes = enc.encode(name);
  const data = enc.encode(content);
  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 0, true); // method: store
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 0, true); // method: store
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true); // local header offset
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, 1, true);
  ev.setUint16(8, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

test("extracts a bare text file as-is", async () => {
  const entries = await extractEntries(fakeFile("sinfo.txt", enc.encode("PARTITION|AVAIL\n")));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "sinfo.txt");
  assert.equal(entries[0].text, "PARTITION|AVAIL\n");
});

test("extracts every file from a tar archive", async () => {
  const tar = buildTar([
    { name: "sinfo.txt", content: "a" },
    { name: "dump/squeue.txt", content: "bb" },
  ]);
  const entries = await extractEntries(fakeFile("dump.tar", tar));
  assert.deepEqual(
    entries.map((e) => [e.name, e.text]),
    [
      ["sinfo.txt", "a"],
      ["dump/squeue.txt", "bb"],
    ],
  );
});

test("extracts a gzip-compressed tar archive", async () => {
  const tar = buildTar([{ name: "sinfo.txt", content: "hello" }]);
  const gz = gzipSync(tar);
  const entries = await extractEntries(fakeFile("dump.tar.gz", gz));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "hello");
});

test("extracts a stored (uncompressed) zip archive", async () => {
  const zip = buildStoreZip("sinfo.txt", "zip content");
  const entries = await extractEntries(fakeFile("dump.zip", zip));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "sinfo.txt");
  assert.equal(entries[0].text, "zip content");
});

test("extracts a single gzip-compressed text file", async () => {
  const gz = gzipSync(enc.encode("squeue dump"));
  const entries = await extractEntries(fakeFile("squeue.txt.gz", gz));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "squeue.txt");
  assert.equal(entries[0].text, "squeue dump");
});

test("rejects a file with no end-of-central-directory record", async () => {
  await assert.rejects(() => extractEntries(fakeFile("bad.zip", enc.encode("not a zip"))));
});
