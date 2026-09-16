import { useState, useEffect } from 'react'
import { supabase, TABLE, STATUSES, genOrderCode } from './supabase'

/* ================= ตัวแยกข้อความอัตโนมัติ ================= */
const PHONE = /(?<!\d)0(?:[\s.\-]?\d){8,9}/g

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

  // ชื่อ TikTok — หลัง "แอค...ตต" มีหรือไม่มี : ก็ได้
  let m = text.match(/แอค[ก-๙a-zA-Z\s]*?ตต(?:tt)?\s*[:：]?\s*(\S.*)/)
  if (m) o.tiktok = m[1].trim()

  // จำนวน + หมายเหตุ (รองรับหัวข้อ สถานะ/จำนวน, มีหรือไม่มีคำว่า "ชุด")
  let statusLine = lines.find((l) => /ชุด/.test(l)) || lines.find((l) => /สถานะ|จำนวน/.test(l)) || ''
  let qm = statusLine.match(/(\d+)\s*ชุด/) || statusLine.match(/(\d+)/)
  if (qm) o.qty = qm[1]
  let noteRaw = statusLine.replace(/สถานะ|จำนวน/g, '').replace(/[:：]/, '')
  if (qm) noteRaw = noteRaw.replace(qm[0], ' ')
  let parts = noteRaw
    .split(/[+*]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^รส\.?$/.test(s) && !/รวมส่ง/.test(s) && !/^ชุด$/.test(s) && !/^\d+$/.test(s))
  o.note = parts.length ? parts.join(', ') : '-'

  // วันที่ส่ง (รองรับ ส่งของวันที่/ส่งวันที่/จัดส่ง/นัดส่ง — ต้องมี DD/MM ในบรรทัดเดียวกัน)
  let dateLine =
    lines.find(
      (l) => /(ส่ง.*วันที่|วันที่ส่ง|วันส่ง|ส่งของ|จัดส่ง|นัดส่ง|รอบส่ง)/.test(l) && /\d{1,2}\s*\/\s*\d{1,2}/.test(l)
    ) || ''
  let dm = dateLine.match(/(\d{1,2})\s*\/\s*(\d{1,2})/)
  if (dm) o.date = dm[1] + '/' + dm[2]

  // บล็อกลูกค้า = บรรทัดที่ไม่ใช่คำทักทาย/สรุป/เลขลำดับ (เลขลำดับ = 1-3 หลัก ไม่ใช่เบอร์โทร)
  const summaryRe = /(^ขอบคุณ|แอค|สถานะ|จำนวน|ส่ง.*วันที่|วันที่ส่ง|^วันส่ง|ส่งของ|จัดส่ง)/
  let block = lines.filter((l) => l && !summaryRe.test(l) && !/^\d{1,3}[.)]?$/.test(l)).join(' ')

  if (block.trim()) {
    o.phone = extractPhones(block).join(' / ')
    let clean = stripPhones(block.replace(/เบอร์โทรศัพท์|เบอร์โทร\.?|โทรศัพท์|เบอร์|โทร\.?|tel\.?/gi, ' '))
    let name = '',
      addr = ''
    const ADDR_KW = /(บ้านเลขที่|เลขที่|\d+\/\d+|\d+\s*ม\.?\s*\d|หมู่\s*\d|\d+\s*หมู่|ซ\.|ซอย|ถ\.|ถนน|ต\.|ตำบล|ตําบล|อ\.|อำเภอ|จ\.|จังหวัด|แขวง|เขต)/
    let labelM = clean.match(/ที่อยู่(?:จัดส่ง)?\s*[:：]?\s*([\s\S]+)/)
    if (labelM) {
      let after = labelM[1]
      name = clean.slice(0, clean.indexOf(labelM[0]))
      if (!name.trim()) {
        let akw = after.match(ADDR_KW)
        if (akw) {
          let i = after.indexOf(akw[0])
          name = after.slice(0, i)
          addr = after.slice(i)
        } else addr = after
      } else addr = after
    } else {
      let akw = clean.match(ADDR_KW)
      if (akw) {
        let i = clean.indexOf(akw[0])
        name = clean.slice(0, i)
        addr = clean.slice(i)
      } else name = clean
    }
    o.name = name.replace(/ชื่อ|ผู้รับ|[:：]/g, '').replace(/\s*\/\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
    o.addr = addr.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  }

  return o
}

// แยกข้อความหลายออเดอร์ที่ก๊อปมาต่อกัน
export function splitOrders(raw) {
  const cleaned = raw.replace(/\r/g, '').replace(/^\s*\d{1,3}[.)]\s*$/gm, '')
  const lines = cleaned.split('\n')
  const starts = []
  lines.forEach((l, i) => {
    if (/แอค[ก-๙a-zA-Z\s]*?ตต/.test(l)) starts.push(i)
  })
  if (starts.length <= 1) {
    const t = cleaned.trim()
    return t ? [t] : []
  }
  const blocks = []
  for (let k = 0; k < starts.length; k++) {
    const s = k === 0 ? 0 : starts[k]
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
  const [filterDate, setFilterDate] = useState('') // '' = ทั้งหมด
  const [trackText, setTrackText] = useState('')
  const [showTrack, setShowTrack] = useState(false)
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return localStorage.getItem('snail_admin_ok') === '1'
    } catch {
      return false
    }
  })
  const [pw, setPw] = useState('')
  const [lockErr, setLockErr] = useState(false)
  const [linkModal, setLinkModal] = useState(null)

  const ADMIN_CODE = import.meta.env.VITE_ADMIN_CODE || 'snailshop'
  function tryUnlock() {
    if (pw === ADMIN_CODE) {
      try {
        localStorage.setItem('snail_admin_ok', '1')
      } catch {}
      setUnlocked(true)
      setLockErr(false)
    } else {
      setLockErr(true)
    }
  }
  function logout() {
    try {
      localStorage.removeItem('snail_admin_ok')
    } catch {}
    setUnlocked(false)
    setPw('')
  }

  const online = !!supabase

  const fromRow = (r) => ({
    id: r.id,
    code: r.code || '',
    status: r.status || STATUSES[0],
    tracking: r.tracking || '',
    tiktok: r.tiktok || '',
    qty: r.qty || 1,
    type: r.type || '',
    date: r.send_date || '',
    name: r.name || '',
    phone: r.phone || '',
    addr: r.addr || '',
    note: r.note || '-',
  })
  const toRow = (o) => ({
    code: o.code || genOrderCode(),
    status: o.status || STATUSES[0],
    tracking: o.tracking || '',
    tiktok: o.tiktok,
    qty: o.qty,
    type: o.type,
    send_date: o.date,
    name: o.name,
    phone: o.phone,
    addr: o.addr,
    note: o.note,
  })

  useEffect(() => {
    if (!online || !unlocked) return
    ;(async () => {
      const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: true })
      if (error) {
        setFlash({ msg: 'โหลดข้อมูลจากฐานข้อมูลไม่ได้: ' + error.message, ok: false })
        return
      }
      const rows = (data || []).map(fromRow)
      setOrders(rows)
      // ค่าเริ่มต้น: เลือกรอบส่งล่าสุด (จะได้ไม่ปนวันอื่น)
      const latest = rows.length ? rows[rows.length - 1].date : ''
      if (latest) setFilterDate(latest)
    })()
  }, [online, unlocked])

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  async function saveOrders(list) {
    if (!online) {
      const withId = list.map((o) => ({ ...o, id: 'local-' + Date.now() + Math.random(), code: genOrderCode(), status: STATUSES[0], tracking: '' }))
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
      const d = parsed.find((o) => o.date)?.date
      if (d) setFilterDate(d)
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
      if (o.date) setFilterDate(o.date)
      setForm({ ...BLANK, date: form.date, qty: 1 })
      setPaste('')
      setFlash({ msg: '', ok: true })
    }
  }

  async function del(o) {
    if (online && o?.id) {
      const { error } = await supabase.from(TABLE).delete().eq('id', o.id)
      if (error) {
        setFlash({ msg: 'ลบไม่สำเร็จ: ' + error.message, ok: false })
        return
      }
    }
    setOrders((prev) => prev.filter((x) => x !== o))
  }

  async function updateStatus(o, status) {
    setOrders((prev) => prev.map((x) => (x === o ? { ...x, status } : x)))
    if (online && o?.id) {
      await supabase.from(TABLE).update({ status }).eq('id', o.id)
    }
  }

  async function copyLink(o) {
    let code = o.code
    if (!code) {
      if (!online) {
        setFlash({ msg: 'ยังไม่ได้ต่อฐานข้อมูล — ลิงก์ใช้ได้เมื่อเชื่อม Supabase แล้ว', ok: false })
        return
      }
      // ออเดอร์เก่ายังไม่มีเลข → สร้างให้แล้วบันทึกลงฐานข้อมูล
      code = genOrderCode()
      const { error } = await supabase.from(TABLE).update({ code }).eq('id', o.id)
      if (error) {
        setFlash({ msg: 'สร้างลิงก์ไม่สำเร็จ: ' + error.message, ok: false })
        return
      }
      setOrders((prev) => prev.map((x) => (x === o ? { ...x, code } : x)))
    }
    const link = `${window.location.origin}/ord/${code}`
    setLinkModal({ link, name: o.name || o.tiktok || '' })
    try {
      await navigator.clipboard.writeText(link)
    } catch {}
  }

  async function clearRound() {
    const label = filterDate || 'ทุกวัน'
    const ids = (filterDate ? orders.filter((o) => (o.date || '') === filterDate) : orders).map((o) => o.id)
    if (ids.length === 0) return
    if (!confirm(`ล้างออเดอร์รอบส่ง ${label}? (ลบถาวร ${ids.length} รายการ)`)) return
    if (online) {
      const { error } = await supabase.from(TABLE).delete().in('id', ids)
      if (error) {
        setFlash({ msg: 'ล้างไม่สำเร็จ: ' + error.message, ok: false })
        return
      }
    }
    setOrders((prev) => prev.filter((o) => !ids.includes(o.id)))
  }

  // จับคู่เลขพัสดุ Flash เข้ากับออเดอร์ (จับด้วยเบอร์ก่อน ไม่เจอค่อยจับด้วยชื่อจริง)
  async function importTracking() {
    if (!trackText.trim()) {
      setFlash({ msg: 'วางข้อมูลจากไฟล์ Flash ก่อนนะคะ', ok: false })
      return
    }
    const norm = (s) => (s || '').replace(/คุณ/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, '').trim()
    const lines = trackText.split('\n').map((l) => l.trim()).filter(Boolean)
    const next = orders.map((o) => ({ ...o }))
    const used = new Set()
    const changed = []
    let matched = 0
    const missed = []
    lines.forEach((line) => {
      const tk = (line.match(/TH[0-9A-Z]{8,}/i) || [])[0]
      if (!tk) return
      const phRaw = (line.match(/(?<!\d)0(?:[\s.\-]?\d){8,9}/) || [])[0]
      const ph = phRaw ? phRaw.replace(/\D/g, '') : ''
      let fname = line.replace(tk, '')
      if (phRaw) fname = fname.replace(phRaw, '')
      const nname = norm(fname.replace(/\t/g, ' '))
      let idx = -1
      // 1) จับด้วยเบอร์
      if (ph) idx = next.findIndex((o, i) => !used.has(i) && (o.phone || '').replace(/\D/g, '').includes(ph))
      // 2) ไม่เจอ → จับด้วยชื่อจริง
      if (idx < 0 && nname)
        idx = next.findIndex((o, i) => {
          if (used.has(i)) return false
          const on = norm(o.name)
          return on && (on === nname || on.includes(nname) || nname.includes(on))
        })
      if (idx < 0) {
        missed.push(tk)
        return
      }
      used.add(idx)
      next[idx].tracking = tk
      next[idx].status = 'ส่งแล้ว'
      changed.push(next[idx])
      matched++
    })
    setOrders(next)
    if (online) {
      for (const o of changed) {
        await supabase.from(TABLE).update({ tracking: o.tracking, status: o.status }).eq('id', o.id)
      }
    }
    setFlash({
      msg: `📦 จับคู่เลขพัสดุได้ ${matched} รายการ${missed.length ? ` · หาเจ้าของไม่เจอ ${missed.length}` : ''}`,
      ok: matched > 0,
    })
    if (matched > 0) setTrackText('')
  }

  const loadDemo = () =>
    setOrders([
      { id: 'demo1', tiktok: '@ปาล์มที่ชอบไปเที่ยว', qty: 4, type: '', date: '15/09', name: 'วริศรา บุญนิยม', phone: '0617215185', addr: 'เลขที่ 30/13 ซอยสำเร็จพัฒนา13 ตำบลปลายบาง อำเภอบางกรวย จังหวัดนนทบุรี 1113', note: '401', status: STATUSES[0], code: '', tracking: '' },
      { id: 'demo2', tiktok: 'baifern_beauty', qty: 1, type: 'เหลี่ยมยาว', date: '15/09', name: 'ใบเฟิร์น สวยงาม', phone: '089-999-1111 / 086-222-3333', addr: '12 ม.5 ต.บางพูด อ.ปากเกร็ด จ.นนทบุรี 11120', note: 'กล่อง', status: STATUSES[0], code: '', tracking: '' },
    ])

  function printLabels() {
    if (visible.length === 0) {
      alert('ยังไม่มีออเดอร์ให้ปริ้นค่ะ 🐌')
      return
    }
    window.print()
  }

  // ===== ตัวกรองรอบส่ง =====
  const dates = [...new Set(orders.map((o) => o.date).filter(Boolean))].sort()
  const visible = filterDate ? orders.filter((o) => (o.date || '') === filterDate) : orders
  const total = visible.reduce((s, o) => s + o.qty, 0)
  const roundLabel = filterDate || 'ทั้งหมด'

  // สร้างข้อความสำหรับก๊อปไปวางในแอปปริ้น (เฉพาะรอบที่เลือก)
  function buildText(withAddr) {
    const date = filterDate || visible.find((o) => o.date)?.date || ''
    const sum = visible.reduce((s, o) => s + o.qty, 0)
    let out = `วันที่ส่ง ${date}\n========================\n\n`
    visible.forEach((o, i) => {
      const noteStr = o.note && o.note !== '-' ? ` + ${o.note}` : ''
      const who = o.tiktok || o.name || '-'
      out += `${i + 1}. แอคเค้าตต : ${who} | ${o.qty} ชุด${noteStr}\n`
      if (withAddr) {
        const line = [o.name, o.addr, o.phone].filter(Boolean).join(' ')
        if (line) out += `${line}\n`
      }
      out += `\n`
    })
    out += `========================\n📦 สรุป วันที่ ${date}\n`
    out += `ออเดอร์: ${visible.length} ราย\nจำนวนชุดรวม: ${sum} ชุด\n\nหมายเหตุ: -`
    return out
  }

  async function copyForPrint(withAddr) {
    if (visible.length === 0) {
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

  if (!unlocked) {
    return (
      <div className="lock-wrap">
        <div className="lock-card">
          <div className="lock-snail">🐌</div>
          <h1>SnailShop</h1>
          <p>สำหรับพนักงานเท่านั้น</p>
          <input
            type="password"
            value={pw}
            onChange={(e) => { setPw(e.target.value); setLockErr(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') tryUnlock() }}
            placeholder="ใส่รหัสผ่าน"
            autoFocus
          />
          {lockErr && <div className="lock-err">รหัสไม่ถูกต้อง ลองใหม่นะคะ</div>}
          <button className="btn btn-primary" onClick={tryUnlock}>เข้าใช้งาน</button>
        </div>
      </div>
    )
  }

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
        <button className="logout-btn no-print" onClick={logout} title="ออกจากระบบ">ออก</button>
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
              <input value={form.date} onChange={set('date')} placeholder="16/09" />
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
        <section className="card no-print">
          <div className="list-head">
            <h2 style={{ margin: 0 }}>
              📋 รอบส่ง {roundLabel} <span className="pill">{visible.length} ออเดอร์ · {total} ชุด</span>
            </h2>
            <div className="toolbar no-print">
              <select className="round-select" value={filterDate} onChange={(e) => setFilterDate(e.target.value)}>
                <option value="">ทุกวัน</option>
                {dates.map((d) => (
                  <option key={d} value={d}>รอบส่ง {d}</option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={() => copyForPrint(true)}>📋 คัดลอก (มีที่อยู่)</button>
              <button className="btn btn-ghost btn-sm" onClick={() => copyForPrint(false)}>📋 คัดลอก (สรุป)</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowTrack((v) => !v)}>📦 ใส่เลขพัสดุ</button>
              <button className="btn btn-ghost btn-sm" onClick={printLabels}>🖨️ ปริ้นใบปะหน้า</button>
              <button className="btn btn-ghost btn-sm" onClick={clearRound}>🗑️ ล้างรอบนี้</button>
            </div>
          </div>

          {showTrack && (
            <div className="copy-box no-print">
              <div className="copy-head">
                <span>วางข้อมูลจากไฟล์ Flash (ก๊อปคอลัมน์ เลขพัสดุ + เบอร์ มาวางได้เลย)</span>
                <button className="mini-x" onClick={() => setShowTrack(false)}>✕ ปิด</button>
              </div>
              <textarea
                value={trackText}
                onChange={(e) => setTrackText(e.target.value)}
                placeholder={'ตัวอย่าง (ก๊อปจาก Excel ทั้งแถวได้):\nTH010395VG1X0C\tคุณวิลาวัลย์\t0853288992\nTH013195VFTF9A0\tคุณอภิญญา\t0930069077'}
              />
              <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={importTracking}>🔗 จับคู่เลขพัสดุ (ด้วยเบอร์โทร)</button>
            </div>
          )}

          {copyText && (
            <div className="copy-box no-print">
              <div className="copy-head">
                <span>ข้อความสำหรับวางในแอปปริ้น (Peripage)</span>
                <button className="mini-x" onClick={() => setCopyText('')}>✕ ปิด</button>
              </div>
              <textarea readOnly value={copyText} onFocus={(e) => e.target.select()} />
            </div>
          )}

          {visible.length === 0 ? (
            <div className="empty">
              <div className="big">🐌</div>
              ยังไม่มีออเดอร์ในรอบนี้ — กรอกฟอร์มด้านซ้าย หรือเลือกรอบส่งอื่น
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อ TikTok</th><th>จำนวน</th><th>หมายเหตุ</th><th>วันส่ง</th>
                    <th>ชื่อจริง</th><th>ที่อยู่</th><th>เบอร์</th>
                    <th className="no-print">สถานะ</th><th className="no-print">ลิงก์</th><th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o, i) => (
                    <tr key={o.id ?? i}>
                      <td className="acc">
                        {o.tiktok || '—'}
                        {o.tracking && <div className="track-tag">📦 {o.tracking}</div>}
                      </td>
                      <td className="qty">{o.qty}</td>
                      <td>{o.note && o.note !== '-' ? <span className="note-tag">{o.note}</span> : '-'}</td>
                      <td>{o.date || '—'}</td>
                      <td>{o.name || '—'}</td>
                      <td className="addr">{o.addr || '—'}</td>
                      <td>{o.phone || '—'}</td>
                      <td className="no-print">
                        <select className="status-select" value={o.status || STATUSES[0]} onChange={(e) => updateStatus(o, e.target.value)}>
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                      <td className="no-print">
                        <button className="icon-btn" title={o.code ? 'คัดลอกลิงก์ ' + o.code : 'สร้าง+คัดลอกลิงก์'} onClick={() => copyLink(o)}>🔗</button>
                      </td>
                      <td className="row-actions no-print">
                        <button className="icon-btn" title="ลบ" onClick={() => del(o)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>รวมรอบนี้</td>
                    <td className="qty">{total}</td>
                    <td colSpan={8}>ชุด</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* ===== PRINT LABELS (Peripage 57x30mm, เฉพาะรอบที่เลือก) ===== */}
      <div className="print-area">
        {visible.map((o, i) => (
          <div className="label" key={o.id ?? i}>
            <div className="lbl-top">
              <span className="lbl-brand">🐌 SnailShop</span>
              <span>{o.date || '-'}</span>
            </div>
            <div className="lbl-acc">แอคเค้าตต: {o.tiktok || '-'}</div>
            <div className="lbl-row"><b>{o.name || '-'}</b> · {o.phone || '-'}</div>
            <div className="lbl-row">จำนวน {o.qty} ชุด{o.note && o.note !== '-' ? ` · ${o.note}` : ''}</div>
            {o.tracking && <div className="lbl-row">พัสดุ: {o.tracking}</div>}
          </div>
        ))}
      </div>
      {/* ===== POPUP ลิงก์ออเดอร์ ===== */}
      {linkModal && (
        <div
          onClick={() => setLinkModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(60,20,40,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 18, padding: 24, width: '100%', maxWidth: 400, boxShadow: '0 20px 50px rgba(0,0,0,.25)', fontFamily: "'Sarabun',sans-serif" }}
          >
            <div style={{ fontFamily: "'Mitr',sans-serif", fontSize: 18, color: 'var(--pink-deep)', marginBottom: 4 }}>🔗 ลิงก์ออเดอร์</div>
            {linkModal.name && <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>{linkModal.name}</div>}
            <input
              readOnly
              value={linkModal.link}
              onFocus={(e) => e.target.select()}
              style={{ width: '100%', fontSize: 13, padding: '11px 12px', border: '1.5px solid var(--line)', borderRadius: 10, background: 'var(--paper)', color: 'var(--ink)', marginBottom: 14, boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(linkModal.link)
                    setFlash({ msg: '📋 คัดลอกแล้ว', ok: true })
                  } catch {}
                }}
              >
                📋 คัดลอก
              </button>
              <a className="btn btn-ghost" style={{ flex: 1, textDecoration: 'none' }} href={linkModal.link} target="_blank" rel="noreferrer">
                ↗ เปิดดู
              </a>
            </div>
            <p className="mini-clear" style={{ marginTop: 12 }} onClick={() => setLinkModal(null)}>ปิด</p>
          </div>
        </div>
      )}
    </>
  )
}
