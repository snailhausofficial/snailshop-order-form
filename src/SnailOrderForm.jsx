import { useState, useEffect } from 'react'
import { supabase, TABLE } from './supabase'

/* ================= ตัวแยกข้อความอัตโนมัติ ================= */
const PHONE = /(?<!\d)0[\d\-\s]{7,13}\d/g

function extractPhones(s) {
  const out = []
  const re = new RegExp(PHONE)
  let m
  while ((m = re.exec(s))) {
    const d = m[0].replace(/\D/g, '')
    if (d.length >= 9 && d.length <= 10) out.push(d)
  }
  return [...new Set(out)]
}

function stripPhones(s) {
  return s.replace(new RegExp(PHONE), (mm) => {
    const d = mm.replace(/\D/g, '')
    return d.length >= 9 && d.length <= 10 ? ' ' : mm
  })
}

export function parseMessage(raw) {
  const text = raw.replace(/\r/g, '')
  const lines = text.split('\n').map((l) => l.trim())
  const o = { tiktok: '', qty: '', type: '', date: '', name: '', phone: '', addr: '', note: '-' }

  // ชื่อ TikTok — หลัง "แอค..." + :
  let m = text.match(/แอค[^\n:：]*[:：]\s*(.+)/)
  if (m) o.tiktok = m[1].trim()

  // จำนวน + หมายเหตุ — จากบรรทัด "สถานะ / ...ชุด..."
  let statusLine = lines.find((l) => /ชุด/.test(l)) || lines.find((l) => /สถานะ/.test(l)) || ''
  let qm = statusLine.match(/(\d+)\s*ชุด/)
  if (qm) o.qty = qm[1]
  else {
    let n = statusLine.replace(/สถานะ/, '').match(/(\d+)/)
    if (n) o.qty = n[1]
  }
  // หมายเหตุ = ส่วนที่เหลือหลังตัด label + จำนวน (คั่นได้ทั้ง + และ *) ตัด "รส/รวมส่ง" ออก
  let noteRaw = statusLine.replace(/สถานะ/, '').replace(/[:：]/, '').replace(/\d+\s*ชุด/, '')
  let parts = noteRaw
    .split(/[+*]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^รส\.?$/.test(s) && !/รวมส่ง/.test(s) && !/^ชุด$/.test(s))
  o.note = parts.length ? parts.join(', ') : '-'

  // วันที่ส่ง (ว่างได้)
  let dateLine = lines.find((l) => /(ส่ง.*วันที่|วันที่ส่ง|วันส่ง|ส่งของ)/.test(l)) || ''
  let dm = dateLine.match(/(\d{1,2})\s*\/\s*(\d{1,2})/)
  if (dm) o.date = dm[1] + '/' + dm[2]

  // บล็อกลูกค้า = บรรทัดที่ไม่ใช่คำทักทาย/สรุป/เลขลำดับ
  const summaryRe = /(^ขอบคุณ|แอค|สถานะ|ส่ง.*วันที่|วันที่ส่ง|^วันส่ง|ส่งของ)/
  let block = lines.filter((l) => l && !summaryRe.test(l) && !/^\d+[.)]?$/.test(l)).join(' ')

  if (block.trim()) {
    o.phone = extractPhones(block).join(' / ')
    // ตัด label เบอร์ + ตัวเลขเบอร์ ออกก่อนแยกชื่อ/ที่อยู่
    let clean = stripPhones(block.replace(/เบอร์โทรศัพท์|เบอร์โทร\.?|โทรศัพท์|เบอร์|โทร\.?|tel\.?/gi, ' '))
    let name = '',
      addr = ''
    let labelM = clean.match(/ที่อยู่\s*[:：]?\s*([\s\S]+)/)
    if (labelM) {
      addr = labelM[1]
      name = clean.slice(0, clean.indexOf(labelM[0]))
    } else {
      // ไม่มี label "ที่อยู่" — หาจุดเริ่มที่อยู่จากคำบอกตำแหน่ง
      let akw = clean.match(
        /(บ้านเลขที่|เลขที่|\d+\/\d+|\d+\s*ม\.?\s*\d|หมู่\s*\d|\d+\s*หมู่|ซ\.|ซอย|ถ\.|ถนน|ต\.|ตำบล|ตําบล|อ\.|อำเภอ|จ\.|จังหวัด|แขวง|เขต)/
      )
      if (akw) {
        let i = clean.indexOf(akw[0])
        name = clean.slice(0, i)
        addr = clean.slice(i)
      } else {
        name = clean
      }
    }
    o.name = name
      .replace(/ชื่อ|ผู้รับ|[:：]/g, '')
      .replace(/\s*\/\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    o.addr = addr.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  }

  return o
}

// แยกข้อความหลายออเดอร์ที่ก๊อปมาต่อกัน (คั่นด้วยเลข 1. 2. หรือคำทักทายซ้ำ)
export function splitOrders(raw) {
  const cleaned = raw.replace(/\r/g, '').replace(/^\s*\d+[.)]\s*$/gm, '')
  const lines = cleaned.split('\n')
  const starts = []
  lines.forEach((l, i) => {
    if (/แอค[^\n]*[:：]/.test(l)) starts.push(i)
  })
  if (starts.length <= 1) {
    const t = cleaned.trim()
    return t ? [t] : []
  }
  const blocks = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : lines.length
    blocks.push(lines.slice(s, e).join('\n'))
  }
  return blocks
}
/* ========================================================= */

const BLANK = { tiktok: '', qty: 1, type: '', date: '', name: '', phone: '', addr: '', note: '' }

export default function SnailOrderForm() {
  const [orders, setOrders] = useState([])
  const [form, setForm] = useState({ ...BLANK })
  const [paste, setPaste] = useState('')
  const [flash, setFlash] = useState({ msg: '', ok: true })
  const [busy, setBusy] = useState(false)
  const [copyText, setCopyText] = useState('')

  const online = !!supabase // ต่อ Supabase อยู่ไหม

  // แปลงแถวจาก DB -> รูปแบบที่แอปใช้
  const fromRow = (r) => ({
    id: r.id,
    tiktok: r.tiktok || '',
    qty: r.qty || 1,
    type: r.type || '',
    date: r.send_date || '',
    name: r.name || '',
    phone: r.phone || '',
    addr: r.addr || '',
    note: r.note || '-',
  })
  // แปลงออเดอร์ในแอป -> แถวสำหรับ DB
  const toRow = (o) => ({
    tiktok: o.tiktok,
    qty: o.qty,
    type: o.type,
    send_date: o.date,
    name: o.name,
    phone: o.phone,
    addr: o.addr,
    note: o.note,
  })

  // โหลดออเดอร์ที่บันทึกไว้ตอนเปิดเว็บ
  useEffect(() => {
    if (!online) return
    ;(async () => {
      const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: true })
      if (error) {
        setFlash({ msg: 'โหลดข้อมูลจากฐานข้อมูลไม่ได้: ' + error.message, ok: false })
        return
      }
      setOrders((data || []).map(fromRow))
    })()
  }, [online])

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  // บันทึกออเดอร์ (1 หรือหลายตัว) — ลง DB ถ้าออนไลน์ ไม่งั้นเก็บในหน้า
  async function saveOrders(list) {
    if (!online) {
      const withId = list.map((o) => ({ ...o, id: 'local-' + Date.now() + Math.random() }))
      setOrders((prev) => [...prev, ...withId])
      return withId.length
    }
    setBusy(true)
    const { data, error } = await supabase.from(TABLE).insert(list.map(toRow)).select()
    setBusy(false)
    if (error) {
      setFlash({ msg: 'บันทึกไม่สำเร็จ: ' + error.message, ok: false })
      return 0
    }
    setOrders((prev) => [...prev, ...(data || []).map(fromRow)])
    return (data || []).length
  }

  function fillFromPaste() {
    if (!paste.trim()) {
      setFlash({ msg: 'ยังไม่มีข้อความให้แยก วางข้อความก่อนนะคะ', ok: false })
      return
    }
    const o = parseMessage(paste)
    setForm({
      tiktok: o.tiktok,
      qty: o.qty || 1,
      type: o.type,
      date: o.date,
      name: o.name,
      phone: o.phone,
      addr: o.addr,
      note: o.note === '-' ? '' : o.note,
    })
    setFlash({ msg: '✅ แยกข้อมูลแล้ว — เช็กความถูกต้องแล้วกด “เพิ่มลงตาราง”', ok: true })
  }

  async function addManyFromPaste() {
    if (!paste.trim()) {
      setFlash({ msg: 'ยังไม่มีข้อความให้แยก วางข้อความก่อนนะคะ', ok: false })
      return
    }
    const parsed = splitOrders(paste)
      .map((b) => parseMessage(b))
      .filter((o) => o.tiktok || o.name || o.qty)
      .map((o) => ({
        tiktok: o.tiktok,
        qty: parseInt(o.qty) || 1,
        type: o.type,
        date: o.date,
        name: o.name,
        phone: o.phone,
        addr: o.addr,
        note: o.note || '-',
      }))
    if (parsed.length === 0) {
      setFlash({ msg: 'แยกไม่ได้ ลองเช็กว่ามีบรรทัด “แอคเค้าตต :” ในแต่ละคนไหม', ok: false })
      return
    }
    const n = await saveOrders(parsed)
    if (n > 0) {
      setForm({ ...BLANK })
      setPaste('')
      setFlash({ msg: `✅ เพิ่ม ${n} ออเดอร์แล้ว${online ? ' (บันทึกลงฐานข้อมูล)' : ''}`, ok: true })
    }
  }

  async function addOrder() {
    const tiktok = form.tiktok.trim()
    const name = form.name.trim()
    if (!tiktok && !name) {
      alert('ใส่ชื่อ TikTok หรือชื่อผู้รับอย่างน้อย 1 อย่างนะคะ 🐌')
      return
    }
    const o = {
      tiktok,
      qty: parseInt(form.qty) || 1,
      type: form.type.trim(),
      date: form.date.trim(),
      name,
      phone: form.phone.trim(),
      addr: form.addr.trim(),
      note: form.note.trim() || '-',
    }
    const n = await saveOrders([o])
    if (n > 0) {
      // เก็บวันส่งไว้ให้กรอกต่อเร็วขึ้น (มักส่งวันเดียวกันหลายคน)
      setForm({ ...BLANK, date: form.date, qty: 1 })
      setPaste('')
      setFlash({ msg: '', ok: true })
    }
  }

  async function del(i) {
    const row = orders[i]
    if (online && row?.id) {
      const { error } = await supabase.from(TABLE).delete().eq('id', row.id)
      if (error) {
        setFlash({ msg: 'ลบไม่สำเร็จ: ' + error.message, ok: false })
        return
      }
    }
    setOrders(orders.filter((_, idx) => idx !== i))
  }

  async function clearAll() {
    if (!confirm('ล้างออเดอร์ทั้งหมด? (ลบถาวรจากฐานข้อมูลด้วย)')) return
    if (online) {
      const { error } = await supabase.from(TABLE).delete().neq('id', '00000000-0000-0000-0000-000000000000')
      if (error) {
        setFlash({ msg: 'ล้างไม่สำเร็จ: ' + error.message, ok: false })
        return
      }
    }
    setOrders([])
  }

  const loadDemo = () =>
    setOrders([
      { id: 'demo1', tiktok: '@ปาล์มที่ชอบไปเที่ยว', qty: 4, type: '', date: '15/09', name: 'วริศรา บุญนิยม', phone: '0617215185', addr: 'เลขที่ 30/13 ซอยสำเร็จพัฒนา13 ตำบลปลายบาง อำเภอบางกรวย จังหวัดนนทบุรี 1113', note: '401' },
      { id: 'demo2', tiktok: 'baifern_beauty', qty: 1, type: 'เหลี่ยมยาว', date: '15/09', name: 'ใบเฟิร์น สวยงาม', phone: '089-999-1111 / 086-222-3333', addr: '12 ม.5 ต.บางพูด อ.ปากเกร็ด จ.นนทบุรี 11120', note: 'กล่อง' },
    ])

  function printLabels() {
    if (orders.length === 0) {
      alert('ยังไม่มีออเดอร์ให้ปริ้นค่ะ 🐌')
      return
    }
    window.print()
  }

  // สร้างข้อความสำหรับก๊อปไปวางในแอปปริ้น (Peripage)
  function buildText(withAddr) {
    const date = orders.find((o) => o.date)?.date || ''
    const total = orders.reduce((s, o) => s + o.qty, 0)
    let out = `วันที่ส่ง ${date}\n========================\n\n`
    orders.forEach((o, i) => {
      const noteStr = o.note && o.note !== '-' ? ` + ${o.note}` : ''
      const who = o.tiktok || o.name || '-'
      out += `${i + 1}. ${who} | ${o.qty} ชุด${noteStr}\n`
      if (withAddr) {
        const line = [o.name, o.addr, o.phone].filter(Boolean).join(' ')
        if (line) out += `${line}\n`
      }
      out += `\n`
    })
    out += `========================\n📦 สรุป วันที่ ${date}\n`
    out += `ออเดอร์: ${orders.length} ราย\nจำนวนชุดรวม: ${total} ชุด\n\nหมายเหตุ: -`
    return out
  }

  async function copyForPrint(withAddr) {
    if (orders.length === 0) {
      setFlash({ msg: 'ยังไม่มีออเดอร์ให้คัดลอกค่ะ 🐌', ok: false })
      return
    }
    const text = buildText(withAddr)
    setCopyText(text)
    try {
      await navigator.clipboard.writeText(text)
      setFlash({ msg: '📋 คัดลอกแล้ว — เปิดแอป Peripage แล้ววาง (paste) ได้เลย', ok: true })
    } catch {
      setFlash({ msg: 'คัดลอกอัตโนมัติไม่ได้ — กดค้างในช่องข้างล่างแล้วก๊อปเองได้', ok: false })
    }
  }

  const total = orders.reduce((s, o) => s + o.qty, 0)

  return (
    <>
      <header>
        <span className="snail">🐌</span>
        <div>
          <h1>SnailShop</h1>
          <p>ฟอร์มกรอกออเดอร์ — เล็บปลอม Handmade</p>
        </div>
        <span className={'conn ' + (online ? 'on' : 'off')}>
          {online ? '● บันทึกลงฐานข้อมูล' : '○ โหมดทดลอง (ยังไม่ต่อฐานข้อมูล)'}
        </span>
      </header>

      <div className="wrap">
        {/* ===== FORM ===== */}
        <section className="card form-card no-print">
          <h2>➕ เพิ่มออเดอร์</h2>
          <p className="hint">วางข้อความจากแชทแล้วให้ระบบแยกให้ หรือกรอกเองก็ได้</p>

          <div className="paste-wrap">
            <label>🪄 วางข้อความจากแชท LINE</label>
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="วาง 1 คน หรือหลายคนต่อกันก็ได้ (มีเลข 1. 2. 3. คั่นหรือไม่มีก็ได้)..."
            />
            <div className="paste-row">
              <button className="btn btn-ghost" onClick={fillFromPaste}>🪄 แยก 1 คน (เช็กก่อน)</button>
              <button className="btn btn-primary" onClick={addManyFromPaste}>📥 เพิ่มหลายคนทีเดียว</button>
            </div>
            <p className="parsed-flash" style={{ color: flash.ok ? 'var(--ok)' : 'var(--pink-deep)' }}>{flash.msg}</p>
            <p className="mini-clear" onClick={() => { setPaste(''); setFlash({ msg: '', ok: true }) }}>ล้างช่องวาง</p>
          </div>

          <div className="divider">แล้วเช็ก / แก้ไขได้ที่นี่</div>

          <div className="field">
            <label>ชื่อแอค TikTok</label>
            <input value={form.tiktok} onChange={set('tiktok')} placeholder="เช่น snail.nails" />
          </div>

          <div className="grid2">
            <div className="field">
              <label>จำนวน (ชุด)</label>
              <input type="number" min="1" value={form.qty} onChange={set('qty')} />
            </div>
            <div className="field">
              <label>วันส่ง</label>
              <input value={form.date} onChange={set('date')} placeholder="15/09" />
            </div>
          </div>

          <div className="field">
            <label>ประเภท</label>
            <input value={form.type} onChange={set('type')} placeholder="เช่น อัลมอนด์สั้น / เหลี่ยมยาว" />
          </div>

          <div className="field">
            <label>ชื่อจริง (ผู้รับ)</label>
            <input value={form.name} onChange={set('name')} placeholder="ชื่อ–นามสกุลผู้รับ" />
          </div>

          <div className="field">
            <label>เบอร์โทร</label>
            <input value={form.phone} onChange={set('phone')} placeholder="0xx-xxx-xxxx (หลายเบอร์คั่นด้วย /)" />
          </div>

          <div className="field">
            <label>ที่อยู่</label>
            <textarea value={form.addr} onChange={set('addr')} placeholder="บ้านเลขที่ ตำบล อำเภอ จังหวัด รหัสไปรษณีย์" />
          </div>

          <div className="field">
            <label>หมายเหตุ / ของแถม</label>
            <input
              value={form.note}
              onChange={set('note')}
              onKeyDown={(e) => { if (e.key === 'Enter') addOrder() }}
              placeholder="เช่น กล่อง, 401, ไพร์มเมอร์ (ไม่มีใส่ -)"
            />
          </div>

          <button className="btn btn-primary" onClick={addOrder}>🐌 เพิ่มลงตาราง</button>
          <p className="save-note">
            {online
              ? '* บันทึกลง Supabase อัตโนมัติ — เปิดเครื่องไหนก็เห็นตารางเดียวกัน'
              : '* ยังไม่ได้ต่อฐานข้อมูล (ตั้งค่า env ใน Vercel) ตอนนี้ข้อมูลอยู่ชั่วคราวในหน้า'}
          </p>
        </section>

        {/* ===== TABLE ===== */}
        <section className="card">
          <div className="list-head">
            <h2 style={{ margin: 0 }}>📋 ออเดอร์วันนี้ <span className="pill">{orders.length} ออเดอร์</span></h2>
            <div className="toolbar no-print">
              <button className="btn btn-ghost btn-sm" onClick={() => copyForPrint(true)}>📋 คัดลอก (มีที่อยู่)</button>
              <button className="btn btn-ghost btn-sm" onClick={() => copyForPrint(false)}>📋 คัดลอก (สรุป)</button>
              <button className="btn btn-ghost btn-sm" onClick={printLabels}>🖨️ ปริ้นใบปะหน้า</button>
              <button className="btn btn-ghost btn-sm" onClick={loadDemo}>✨ ใส่ตัวอย่าง</button>
              <button className="btn btn-ghost btn-sm" onClick={clearAll}>🗑️ ล้างทั้งหมด</button>
            </div>
          </div>

          {copyText && (
            <div className="copy-box no-print">
              <div className="copy-head">
                <span>ข้อความสำหรับวางในแอปปริ้น (Peripage)</span>
                <button className="mini-x" onClick={() => setCopyText('')}>✕ ปิด</button>
              </div>
              <textarea readOnly value={copyText} onFocus={(e) => e.target.select()} />
            </div>
          )}

          {orders.length === 0 ? (
            <div className="empty">
              <div className="big">🐌</div>
              ยังไม่มีออเดอร์ — กรอกฟอร์มด้านซ้ายเพื่อเริ่ม
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อ TikTok</th><th>จำนวน</th><th>หมายเหตุ</th><th>วันส่ง</th>
                    <th>ชื่อจริง</th><th>ที่อยู่</th><th>เบอร์</th><th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o, i) => (
                    <tr key={o.id ?? i}>
                      <td className="acc">{o.tiktok || '—'}</td>
                      <td className="qty">{o.qty}</td>
                      <td>{o.note && o.note !== '-' ? <span className="note-tag">{o.note}</span> : '-'}</td>
                      <td>{o.date || '—'}</td>
                      <td>{o.name || '—'}</td>
                      <td className="addr">{o.addr || '—'}</td>
                      <td>{o.phone || '—'}</td>
                      <td className="row-actions no-print">
                        <button className="icon-btn" title="ลบ" onClick={() => del(i)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>รวมทั้งหมด</td>
                    <td className="qty">{total}</td>
                    <td colSpan={6}>ชุด</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* ===== PRINT LABELS ===== */}
      <div className="print-area">
        {orders.map((o, i) => (
          <div className="label" key={o.id ?? i}>
            <div className="lbl-top">
              <span className="lbl-brand">🐌 SnailShop</span>
              <span>ส่ง: {o.date || '-'}</span>
            </div>
            <div className="lbl-sec">
              <div className="k">ผู้ส่ง</div>
              <div className="v">SnailShop (เล็บปลอม Handmade)</div>
            </div>
            <div className="lbl-sec">
              <div className="k">ผู้รับ</div>
              <div className="v"><b>{o.name || '-'}</b> &nbsp; โทร {o.phone || '-'}</div>
              <div className="v">{o.addr || '-'}</div>
            </div>
            <div className="lbl-items">
              <span>รายการ: {o.type || 'เล็บปลอม'} × {o.qty} ชุด</span>
              <span>{o.note && o.note !== '-' ? 'แถม: ' + o.note : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
