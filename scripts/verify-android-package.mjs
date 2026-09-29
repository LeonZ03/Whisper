import assert from 'node:assert/strict';

// Android 11's installer requires resources.arsc to be ZIP_STORED and four-byte
// aligned. Generic ZIP/signature tools do not reject a compressed resource table.
export function verifyAndroidPackage(input) {
  const bytes = Buffer.from(input); let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  assert.ok(end >= 0, 'APK ZIP directory is missing.');
  const count = bytes.readUInt16LE(end + 10); let cursor = bytes.readUInt32LE(end + 16);
  const names = new Set(); let table;
  for (let index = 0; index < count; index++) {
    assert.ok(cursor + 46 <= bytes.length && bytes.readUInt32LE(cursor) === 0x02014b50, 'Invalid APK ZIP entry.');
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    assert.ok(next <= bytes.length, 'Truncated APK ZIP directory.');
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.ok(!names.has(name), 'Duplicate APK entry: ' + name); names.add(name);
    if (name === 'resources.arsc') {
      const method = bytes.readUInt16LE(cursor + 10), local = bytes.readUInt32LE(cursor + 42);
      assert.ok(local + 30 <= bytes.length && bytes.readUInt32LE(local) === 0x04034b50, 'Missing resource table local header.');
      assert.equal(method, 0, 'resources.arsc must be uncompressed (Android 11+ install requirement).');
      assert.equal(bytes.readUInt16LE(local + 8), 0, 'Resource table compression methods disagree.');
      const dataOffset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      assert.equal(dataOffset % 4, 0, 'resources.arsc must be aligned on a four-byte boundary.');
      table = { compressed: false, dataOffset, aligned: true };
    }
    cursor = next;
  }
  assert.ok(table, 'resources.arsc is missing.');
  for (const name of ['AndroidManifest.xml', 'classes.dex', 'assets/index.html', 'assets/app.js']) assert.ok(names.has(name), 'Missing APK component: ' + name);
  return { resources: table, fileCount: count };
}
