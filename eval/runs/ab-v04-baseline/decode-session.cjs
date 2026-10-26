#!/usr/bin/env node
// Decode a multi-frame `.jsonl.zstd` session log.
//
// `zstdDecompressSync` stops after the first frame, which is why reading a session
// log that way returns exactly one record. The durable log is written as a series
// of independently-flushed frames, so it must be decoded with a streaming decoder
// (or frame by frame) to see the whole run.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Every offset where a zstd frame magic appears. */
function frameStarts(buf) {
  const starts = [];
  let at = buf.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 4);
  }
  return starts;
}

function decodeStreaming(buf) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const dec = zlib.createZstdDecompress();
    dec.on('data', (c) => chunks.push(c));
    dec.on('end', () => resolve(Buffer.concat(chunks)));
    dec.on('error', reject);
    dec.end(buf);
  });
}

/** Split at magic offsets and decode each frame, skipping splits that are not real. */
function decodeFrames(buf) {
  const starts = frameStarts(buf);
  const parts = [];
  let decodedFrames = 0;
  for (let i = 0; i < starts.length; i++) {
    const slice = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length);
    try {
      parts.push(zlib.zstdDecompressSync(slice));
      decodedFrames++;
    } catch {
      // A magic sequence inside compressed payload: fold it back into the frame
      // before it and retry, so a false split cannot lose data.
      if (parts.length === 0) continue;
      const merged = Buffer.concat([slice, parts.pop()]);
      try { parts.push(zlib.zstdDecompressSync(merged)); } catch { parts.push(merged); }
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), decodedFrames, starts: starts.length };
}

async function decodeFile(file) {
  const buf = fs.readFileSync(file);
  const streamed = await decodeStreaming(buf);
  const framed = decodeFrames(buf);
  const streamLines = streamed.toString('utf8').split('\n').filter(Boolean).length;
  const framedLines = framed.text.split('\n').filter(Boolean).length;
  // Prefer the decode that yields more complete lines; both must agree on content.
  const text = framedLines >= streamLines ? framed.text : streamed.toString('utf8');
  const lines = text.split('\n').filter(Boolean);
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return { records, streamLines, framedLines, decodedFrames: framed.decodedFrames, magicHits: framed.starts };
}

module.exports = { decodeFile, decodeStreaming, decodeFrames };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node decode-session.cjs <session.v4.jsonl.zstd>');
    process.exit(2);
  }
  decodeFile(file).then((r) => {
    console.log(`file: ${path.basename(path.dirname(file))}`);
    console.log(`  streaming decoder: ${r.streamLines} lines`);
    console.log(`  frame-by-frame:    ${r.framedLines} lines (${r.decodedFrames} frames decoded, ${r.magicHits} magic hits)`);
    console.log(`  parsed records:    ${r.records.length}`);
    const types = new Map();
    for (const rec of r.records) types.set(rec.type ?? '(none)', (types.get(rec.type ?? '(none)') || 0) + 1);
    for (const [t, n] of [...types].sort((a, b) => b[1] - a[1])) console.log(`    ${t}  x${n}`);
  }).catch((e) => {
    console.error('decode failed:', e.message);
    process.exit(1);
  });
}
