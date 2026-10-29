import { useState } from 'react'
import { supabase } from './supabase'
import { ddmm, baht, fileUrl, groupItems, artisanShort } from './ArtisanJobs.jsx'

/* =====================================================================
   บิลจ่ายช่างรายเดือน → ลงค่าใช้จ่าย FlowAccount
   1 สลิป (รายการจ่าย) = 1 เอกสารใน Flow
   - ⬇ Excel (CSV) · ⬇ สลิปทั้งเดือน (.zip ชื่อไฟล์ = วันที่_รหัส_ชื่อ_ยอด)
   - 📋 คัดลอกบิลที่ยังไม่ลง Flow → วางในแชท Claude ให้สร้างเอกสารให้
   - ✔ ลง Flow แล้ว (ใส่เลขเอกสาร) กันลงซ้ำ
   ===================================================================== */

export const monthOf = (iso) => (iso || '').slice(0, 7)
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
export const monthLabel = (ym) => `${TH_M[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`

export function MonthNav({ month, setMonth }) {
  return (
    <div className="jb-row" style={{ justifyContent: 'center', margin: '4px 0 10px' }}>
      <button className="btn btn-ghost btn-sm" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
      <span style={{ fontFamily: 'Itim', fontSize: 18, color: 'var(--pink-deep)', minWidth: 110, textAlign: 'center' }}>{monthLabel(month)}</span>
      <button className="btn btn-ghost btn-sm" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
    </div>
  )
}

/* ---------- zip แบบไม่บีบอัด (ไม่ต้องลง library เพิ่ม) ---------- */
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function makeZip(files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true)
    h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true)
    h.setUint16(26, name.length, true)
    parts.push(new Uint8Array(h.buffer), name, f.data)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true)
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true)
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true)
    central.push(new Uint8Array(c.buffer), name)
    offset += 30 + name.length + f.data.length
  }
  const size = central.reduce((s, p) => s + p.length, 0)
  const e = new DataView(new ArrayBuffer(22))
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true)
  e.setUint32(12, size, true); e.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' })
}
function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}
const safe = (s) => (s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

export function ArtisanBills({ jobs, artById, say, refresh, onOpen, onBack }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [busy, setBusy] = useState('')
  const [docNo, setDocNo] = useState({})
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  const bills = jobs
    .flatMap((j) => (j.job_payments || []).map((p) => ({ p, j, a: artById[j.artisan_id] })))
    .filter((x) => monthOf(x.p.paid_on) === month)
    .sort((x, y) => (x.p.paid_on || '').localeCompare(y.p.paid_on || '') || x.p.id - y.p.id)
  const offsys = jobs.filter((j) => j.paid_offsystem && monthOf(j.order_date) === month)
  const total = bills.reduce((s, x) => s + (Number(x.p.amount) || 0), 0)
  const todo = bills.filter((x) => !x.p.flow_doc)

  const fileName = (x) => {
    const ext = (x.p.slip_path.split('.').pop() || 'jpg').toLowerCase()
    return `${x.p.paid_on}_${x.a?.code || 'xxx'}_${safe(x.a?.nickname || x.a?.name)}_${Math.round(x.p.amount)}.${ext}`
  }
  const itemsText = (j) =>
    groupItems(j.job_items)
      .map((g) => `${g.design} ${g.sizes.map((i) => i.size + i.qty).join(' ')}`)
      .join(' / ') + (Number(j.ship_fee) ? ` + ค่าส่ง ${baht(j.ship_fee)}` : '')
  const row = (x) => [
    x.p.paid_on,
    x.a?.name || '',
    x.a?.code || '',
    x.a?.nickname || '',
    x.p.kind,
    `ค่าเล็บ ${itemsText(x.j)}`,
    (x.j.job_items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0),
    Number(x.p.amount) || 0,
    x.j.code,
    x.p.slip_path ? fileName(x) : '(ไม่มีสลิป)',
    x.p.slip_path ? fileUrl(x.p.slip_path) : '',
    x.a && x.a.in_flow === false ? 'ยังไม่มีใน Flow' : '',
    x.p.flow_doc || '',
  ]
  const HEAD = ['วันที่จ่าย', 'ผู้จำหน่าย (ชื่อตาม Flow)', 'รหัสช่าง', 'ชื่อในใบ', 'ประเภท', 'รายการ', 'ชุด', 'ยอดโอน', 'เลขใบงาน', 'ไฟล์สลิป', 'ลิงก์สลิป', 'หมายเหตุ', 'เลขเอกสาร Flow']

  function exportCsv() {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
    const csv = '﻿' + [HEAD, ...bills.map(row)].map((r) => r.map(esc).join(',')).join('\r\n')
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `บิลจ่ายช่าง_${month}.csv`)
  }

  async function exportZip() {
    const withSlip = bills.filter((x) => x.p.slip_path)
    if (!withSlip.length) return say('เดือนนี้ไม่มีสลิป', false)
    setBusy('zip')
    try {
      const files = []
      for (const x of withSlip) {
        const { data, error } = await supabase.storage.from('job-files').download(x.p.slip_path)
        if (error) throw error
        files.push({ name: fileName(x), data: new Uint8Array(await data.arrayBuffer()) })
      }
      download(makeZip(files), `สลิปช่าง_${month}.zip`)
      say(`⬇ โหลดสลิป ${files.length} ไฟล์แล้ว`)
    } catch (e) {
      say('โหลดสลิปไม่สำเร็จ: ' + e.message, false)
    } finally {
      setBusy('')
    }
  }

  async function copyForClaude() {
    if (!todo.length) return say('ทุกบิลเดือนนี้ลง Flow แล้ว', false)
    const text =
      `ลงค่าใช้จ่าย FlowAccount — บิลจ่ายช่าง ${monthLabel(month)} (${todo.length} บิล · 1 บิล = 1 เอกสาร · จ่ายแล้ว)\n` +
      [['รหัสบิล', ...HEAD.slice(0, 10)], ...todo.map((x) => ['B' + x.p.id, ...row(x).slice(0, 10)])].map((r) => r.join('\t')).join('\n') +
      `\n\nลงเสร็จหรือเจอเอกสารเดิมแล้ว ให้ตอบกลับเป็นบรรทัด "รหัสบิล เลขEXP" เช่น B12 EXP2026100001 (ไว้วางกลับในเว็บ)`
    try {
      await navigator.clipboard.writeText(text)
      say(`📋 คัดลอก ${todo.length} บิลแล้ว — วางในแชท Claude ได้เลย`)
    } catch {
      window.prompt('คัดลอกข้อความนี้', text)
    }
  }

  async function markFlow(x) {
    const no = (docNo[x.p.id] || '').trim()
    if (!no) return say('ใส่เลขเอกสาร Flow ก่อนนะคะ', false)
    if (!window.confirm(`บันทึกว่าบิล ${ddmm(x.p.paid_on)} ${artisanShort(x.a)} ${baht(x.p.amount)} ฿ ลง Flow แล้ว (เลข ${no}) ใช่ไหม?`)) return
    const { error } = await supabase.from('job_payments').update({ flow_doc: no, flow_at: new Date().toISOString() }).eq('id', x.p.id)
    if (error) return say('บันทึกไม่สำเร็จ: ' + error.message, false)
    await refresh(x.j.id)
    say('✅ ติ๊กลง Flow แล้ว')
  }
  // วางผลจาก Claude: บรรทัดละ "B<รหัสบิล> EXP..." → ติ๊กลง Flow ทีเดียวหลายบิล
  const allBills = jobs.flatMap((j) => (j.job_payments || []).map((p) => ({ p, j, a: artById[j.artisan_id] })))
  const pasted = [...pasteText.matchAll(/B(\d+)\D{0,12}?(EXP\d{6,})/gi)]
    .map((m) => ({ x: allBills.find((b) => String(b.p.id) === m[1]), no: m[2].toUpperCase(), id: m[1] }))
  async function applyPaste() {
    const ok = pasted.filter((r) => r.x)
    if (!ok.length) return say('ไม่เจอรหัสบิลที่ตรงกัน — ต้องเป็นบรรทัดแบบ B12 EXP2026100001', false)
    const lines = ok.map((r) => `${ddmm(r.x.p.paid_on)} ${artisanShort(r.x.a)} ${baht(r.x.p.amount)} ฿ → ${r.no}${r.x.p.flow_doc ? ` (เดิม ${r.x.p.flow_doc})` : ''}`)
    if (!window.confirm(`บันทึกเลข Flow ${ok.length} บิลนี้ใช่ไหม?\n\n${lines.join('\n')}`)) return
    setBusy('paste')
    try {
      for (const r of ok) {
        const { error } = await supabase.from('job_payments').update({ flow_doc: r.no, flow_at: new Date().toISOString() }).eq('id', r.x.p.id)
        if (error) throw error
      }
      for (const jid of [...new Set(ok.map((r) => r.x.j.id))]) await refresh(jid)
      setPasteText('')
      setPasteOpen(false)
      say(`✅ ติ๊กลง Flow แล้ว ${ok.length} บิล`)
    } catch (e) {
      say('บันทึกไม่สำเร็จ: ' + e.message, false)
    } finally {
      setBusy('')
    }
  }

  async function unmarkFlow(x) {
    if (!window.confirm(`ยกเลิกสถานะ "ลง Flow แล้ว" ของบิลนี้ใช่ไหม?`)) return
    const { error } = await supabase.from('job_payments').update({ flow_doc: '', flow_at: null }).eq('id', x.p.id)
    if (error) return say('บันทึกไม่สำเร็จ: ' + error.message, false)
    await refresh(x.j.id)
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={onBack}>← รายการใบงาน</button>
      <div className="jb-card">
        <h3><span>🧾 บิลจ่ายช่าง / ลง Flow</span></h3>
        <MonthNav month={month} setMonth={setMonth} />
        <div className="jb-kv">
          <span>{bills.length} บิล · ยังไม่ลง Flow {todo.length}</span>
          <b>รวม {baht(total)} ฿</b>
        </div>
        {offsys.length > 0 && <p className="jb-small">+ จ่ายนอกระบบ {offsys.length} ใบงาน (ไม่มีบิลในระบบ)</p>}
        <div className="jb-menu" style={{ marginTop: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!bills.length}>⬇ Excel (CSV)</button>
          <button className="btn btn-ghost btn-sm" onClick={exportZip} disabled={!!busy}>{busy === 'zip' ? 'กำลังโหลด...' : '⬇ สลิปทั้งเดือน (.zip)'}</button>
        </div>
        <button className="btn btn-rose btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={copyForClaude}>📋 คัดลอกบิลที่ยังไม่ลง Flow (ให้ Claude สร้างเอกสาร)</button>
        <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => setPasteOpen(!pasteOpen)}>📥 วางเลข Flow จาก Claude</button>
        {pasteOpen && (
          <div style={{ marginTop: 8 }}>
            <textarea rows={4} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'วางข้อความที่ Claude ตอบกลับ เช่น\nB12 EXP2026100118\nB15 EXP2026090114'} style={{ width: '100%', fontSize: 14 }} />
            {pasted.length > 0 && (
              <div className="jb-small" style={{ margin: '6px 0' }}>
                {pasted.map((r, i) => (
                  <div key={i}>{r.x ? `✓ ${ddmm(r.x.p.paid_on)} ${artisanShort(r.x.a)} ${baht(r.x.p.amount)} ฿ → ${r.no}` : `✗ B${r.id} ไม่เจอบิลนี้`}</div>
                ))}
              </div>
            )}
            <button className="btn btn-rose btn-sm" style={{ width: '100%' }} disabled={!!busy || !pasted.some((r) => r.x)} onClick={applyPaste}>
              {busy === 'paste' ? 'กำลังบันทึก...' : `✔ บันทึก ${pasted.filter((r) => r.x).length} บิล`}
            </button>
          </div>
        )}
      </div>

      {bills.length === 0 && <div className="jb-card"><p className="jb-muted">เดือนนี้ยังไม่มีบิลจ่าย</p></div>}
      {bills.map((x) => (
        <div key={x.p.id} className="jb-card" style={{ padding: 12 }}>
          <div className="jb-row" style={{ justifyContent: 'space-between' }}>
            <b style={{ fontWeight: 400, color: 'var(--plum)', cursor: 'pointer' }} onClick={() => onOpen(x.j.id)}>
              {ddmm(x.p.paid_on)} · {artisanShort(x.a)}
            </b>
            <span style={{ fontFamily: 'Itim', color: 'var(--pink-deep)' }}>{baht(x.p.amount)} ฿</span>
          </div>
          <div className="jb-small">
            B{x.p.id} · {x.p.kind} · {x.a?.name || ''}{x.a?.code ? ` (${x.a.code})` : ''} · ใบงาน {x.j.code}
          </div>
          <div className="jb-row" style={{ marginTop: 6 }}>
            {x.p.slip_path ? (
              <a className="jb-link" href={fileUrl(x.p.slip_path)} target="_blank" rel="noreferrer">🧾 {fileName(x)}</a>
            ) : (
              <span className="tag rd">ไม่มีสลิป</span>
            )}
            {x.a?.in_flow === false && <span className="tag am">ยังไม่มีใน Flow</span>}
          </div>
          {x.p.flow_doc ? (
            <div className="jb-row" style={{ marginTop: 6 }}>
              <span className="tag gr">✓ ลง Flow แล้ว {x.p.flow_doc}</span>
              <button className="icon-btn" title="ยกเลิก" onClick={() => unmarkFlow(x)}>↩</button>
            </div>
          ) : (
            <div className="jb-row" style={{ marginTop: 6 }}>
              <input className="jb-grow" style={{ padding: '7px 9px', fontSize: 14 }} value={docNo[x.p.id] || ''} onChange={(e) => setDocNo({ ...docNo, [x.p.id]: e.target.value })} placeholder="เลขเอกสาร Flow เช่น EXP2026110001" />
              <button className="btn btn-ghost btn-sm" onClick={() => markFlow(x)}>✔ ลง Flow แล้ว</button>
            </div>
          )}
        </div>
      ))}
    </>
  )
}
