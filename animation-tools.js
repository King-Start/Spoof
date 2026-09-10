// Independent RBXM animation attribute patcher.
// Uses MIT-licensed rbxm-parser for binary RBXM read/write.
const { RobloxFile } = require('rbxm-parser');

function need(buf, off, n) {
  if (off + n > buf.length) throw new Error('AttributesSerialize terpotong/rusak');
}
function u32(buf, off) { need(buf, off, 4); return buf.readUInt32LE(off); }

function valueEnd(buf, off) {
  need(buf, off, 1);
  const type = buf[off++];
  const fixed = { 3: 1, 5: 4, 6: 8, 9: 8, 10: 16, 14: 4, 15: 12, 16: 8, 17: 12, 27: 8, 28: 16 };
  if (fixed[type] != null) { need(buf, off, fixed[type]); return off + fixed[type]; }
  if (type === 2) { const n = u32(buf, off); off += 4; need(buf, off, n); return off + n; }
  if (type === 20) {
    need(buf, off, 13);
    const rotationId = buf[off + 12];
    return off + 13 + (rotationId === 0 ? 36 : 0);
  }
  if (type === 23 || type === 25) {
    const count = u32(buf, off); off += 4;
    const stride = type === 23 ? 12 : 20;
    need(buf, off, count * stride);
    return off + count * stride;
  }
  throw new Error(`Tipe attribute Roblox ${type} belum didukung; file tidak diubah demi keamanan`);
}

function stripOneAttribute(raw, target = 'MaxPartTranslation') {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'latin1');
  if (buf.length < 4) return { raw, removed: 0, names: [] };
  const count = u32(buf, 0);
  if (count > 10000) throw new Error('Jumlah attribute tidak wajar');
  let off = 4;
  const kept = [], names = [];
  let removed = 0;
  for (let i = 0; i < count; i++) {
    const start = off;
    const nameLen = u32(buf, off); off += 4;
    if (nameLen > 100 || off + nameLen > buf.length) throw new Error('Nama attribute rusak');
    const name = buf.subarray(off, off + nameLen).toString('utf8');
    names.push(name);
    off += nameLen;
    off = valueEnd(buf, off);
    if (name.toLowerCase() === target.toLowerCase()) removed++;
    else kept.push(buf.subarray(start, off));
  }
  if (off !== buf.length) throw new Error('Ada data attribute tambahan yang tidak dikenali');
  if (!removed) return { raw, removed: 0, names };
  const head = Buffer.alloc(4); head.writeUInt32LE(kept.length, 0);
  const out = Buffer.concat([head, ...kept]);
  return { raw: out.toString('latin1'), removed, names };
}

function walk(inst, fn) {
  fn(inst);
  for (const child of inst.Children || []) walk(child, fn);
}

function patchAnimationRbxm(input) {
  let file;
  try { file = RobloxFile.ReadFromBuffer(input); }
  catch (e) { throw new Error('RBXM tidak dapat diparse: ' + e.message); }
  if (!file || !file.Roots || !file.Roots.length) throw new Error('RBXM animasi kosong/tidak valid');
  const classes = new Set();
  const poseNames = new Set();
  let removed = 0, blobs = 0;
  for (const root of file.Roots) walk(root, (inst) => {
    classes.add(inst.ClassName);
    if (inst.ClassName === 'Pose') poseNames.add(inst.Name);
    const prop = inst.Props && inst.Props.get('AttributesSerialize');
    if (!prop || prop.type !== 1 || !prop.value) return;
    blobs++;
    const result = stripOneAttribute(prop.value, 'MaxPartTranslation');
    if (result.removed) {
      inst.SetProp('AttributesSerialize', 1, result.raw);
      removed += result.removed;
    }
  });
  if (!classes.has('KeyframeSequence') && !classes.has('CurveAnimation')) {
    throw new Error('RBXM tidak berisi KeyframeSequence/CurveAnimation');
  }
  const r6 = ['Torso','Left Arm','Right Arm','Left Leg','Right Leg'].some((n) => poseNames.has(n));
  const r15 = ['UpperTorso','LowerTorso','LeftUpperArm','RightUpperArm','LeftUpperLeg','RightUpperLeg'].some((n) => poseNames.has(n));
  let output;
  try { output = file.WriteToBuffer(); }
  catch (e) { throw new Error('Gagal menulis ulang RBXM: ' + e.message); }
  return { buffer: output, removed, attributeBlobs: blobs, rig: r15 ? 'R15' : r6 ? 'R6' : 'Unknown' };
}

module.exports = { stripOneAttribute, patchAnimationRbxm };
