// Pulls the SLURM dump files out of an uploaded .zip, .tar, .tar.gz/.tgz, .gz,
// or bare text file. No dependency: gzip/deflate use the browser's native
// DecompressionStream instead of a bundled inflate implementation.

const decoder = new TextDecoder();

export async function extractEntries(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".zip")) return extractZip(await file.arrayBuffer());
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return extractTar(await gunzip(await file.arrayBuffer()));
  if (name.endsWith(".tar")) return extractTar(await file.arrayBuffer());
  if (name.endsWith(".gz"))
    return [{ name: file.name.replace(/\.gz$/i, ""), text: decoder.decode(await gunzip(await file.arrayBuffer())), mtime: new Date(file.lastModified) }];
  return [{ name: file.name, text: await file.text(), mtime: new Date(file.lastModified) }];
}

async function decompress(buf, format) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).arrayBuffer();
}
const gunzip = (buf) => decompress(buf, "gzip");
const inflateRaw = (buf) => decompress(buf, "deflate-raw");

// ---------------------------------------------------------------- tar

function tarField(bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
}

function tarOctal(bytes) {
  const s = tarField(bytes);
  return s ? parseInt(s, 8) : 0;
}

async function extractTar(buf) {
  const bytes = new Uint8Array(buf);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = tarField(header.subarray(0, 100));
    const size = tarOctal(header.subarray(124, 136));
    const mtime = tarOctal(header.subarray(136, 148));
    const typeflag = String.fromCharCode(header[156] || 0);
    offset += 512;
    // "0" is a regular file; some writers leave typeflag blank for one too.
    if (name && !name.endsWith("/") && (typeflag === "0" || typeflag === "\0")) {
      const data = bytes.subarray(offset, offset + size);
      entries.push({ name, text: decoder.decode(data), mtime: mtime ? new Date(mtime * 1000) : null });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ---------------------------------------------------------------- zip
//
// Reads the central directory from the end of the archive — the part every
// zip writer keeps accurate — rather than walking local headers in order.

function findEOCD(view) {
  const scanFrom = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function dosDateTime(time, date) {
  if (!time && !date) return null;
  const day = date & 0x1f;
  const month = (date >> 5) & 0x0f;
  const year = ((date >> 9) & 0x7f) + 1980;
  const seconds = (time & 0x1f) * 2;
  const minutes = (time >> 5) & 0x3f;
  const hours = (time >> 11) & 0x1f;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

async function extractZip(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const eocd = findEOCD(view);
  if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory record)");

  const entryCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break; // central directory signature
    const method = view.getUint16(cdOffset + 10, true);
    const modTime = view.getUint16(cdOffset + 12, true);
    const modDate = view.getUint16(cdOffset + 14, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localOffset = view.getUint32(cdOffset + 42, true);
    const name = decoder.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));

    if (!name.endsWith("/")) {
      // The local header's own name/extra field lengths decide where the data
      // starts, since they need not match the central directory's.
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = bytes.slice(dataStart, dataStart + compSize);
      if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported zip compression method ${method}`);
      const data = method === 0 ? raw.buffer : await inflateRaw(raw);
      entries.push({ name, text: decoder.decode(data), mtime: dosDateTime(modTime, modDate) });
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
