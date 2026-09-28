import { useState, useEffect, useRef } from 'react'
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

// โดเมนหลักของเว็บ (ลิงก์ที่ส่งให้ลูกค้าจะใช้ตัวนี้เสมอ) — เปลี่ยนได้ที่นี่ หรือตั้ง env VITE_SITE_URL
const SITE_URL = import.meta.env.VITE_SITE_URL || 'https://order.snailshop.org'

export default function SnailOrderForm() {
  const [orders, setOrders] = useState([])
  const [pSummary, setPSummary] = useState('')
  const [pAddr, setPAddr] = useState('')
  const [flash, setFlash] = useState({ msg: '', ok: true })
  const [busy, setBusy] = useState(false)
  const [copyText, setCopyText] = useState('')
  const [filterDate, setFilterDate] = useState('') // '' = ทั้งหมด
  const [trackText, setTrackText] = useState('')
  const [showTrack, setShowTrack] = useState(false)
  const [unmatched, setUnmatched] = useState([])
  const [copiedBtn, setCopiedBtn] = useState('')
  // ===== ล็อกอินพนักงาน (Supabase Auth) =====
  const [unlocked, setUnlocked] = useState(false)
  const [authChecked, setAuthChecked] = useState(false) // เช็ก session เสร็จหรือยัง (กันหน้าล็อกกะพริบ)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [lockErr, setLockErr] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [linkModal, setLinkModal] = useState(null)

  // เปิดหน้ามา → เช็กว่าเคยล็อกอินค้างไว้ไหม + คอยฟังการล็อกอิน/ล็อกเอาต์
  useEffect(() => {
    if (!supabase) {
      // ยังไม่ต่อฐานข้อมูล = โหมดทดลอง ข้อมูลอยู่ในเครื่อง ไม่ต้องล็อกอิน
      setUnlocked(true)
      setAuthChecked(true)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setUnlocked(!!data.session)
      setAuthChecked(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUnlocked(!!session)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  async function tryUnlock() {
    if (!email.trim() || !pw) {
      setLockErr(true)
      return
    }
    setLoggingIn(true)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw })
    setLoggingIn(false)
    if (error) {
      setLockErr(true)
    } else {
      setLockErr(false)
      setPw('')
    }
  }

  async function logout() {
    if (supabase) await supabase.auth.signOut()
    setOrders([])
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

  async function saveOrders(list) {
    if (!online) {
      const withId = list.map((o) => ({ ...o, id: 'local-' + Date.now() + Math.random(), code: genOrderCode(), status: STATUSES[0], tracking: '' }))
      setOrders((prev) => [...prev, ...withId])
      return withId
    }
    setBusy(true)
    const { data, error } = await supabase.from(TABLE).insert(list.map(toRow)).select()
    setBusy(false)
    if (error) {
      setFlash({ msg: 'บันทึกไม่สำเร็จ: ' + error.message, ok: false })
      return []
    }
    const rows = (data || []).map(fromRow)
    setOrders((prev) => [...prev, ...rows])
    return rows
  }

  // วางสรุป + ที่อยู่ (คนละช่อง) → รวมกัน → เข้าตารางเลย ไม่ต้องตรวจ
  async function addFromBoxes() {
    const combined = (pSummary + '\n\n' + pAddr).trim()
    if (!combined) {
      setFlash({ msg: 'วางข้อความก่อนนะคะ', ok: false })
      return
    }
    const parsed = splitOrders(combined)
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
      setFlash({ msg: 'แยกไม่ได้ ลองเช็กว่ามีบรรทัด “แอคเค้าตต” ไหม', ok: false })
      return
    }
    const added = await saveOrders(parsed)
    if (added.length > 0) {
      const d = parsed.find((o) => o.date)?.date
      if (d) setFilterDate(d)
      setPSummary('')
      setPAddr('')
      if (added.length === 1) {
        // เพิ่มคนเดียว → เด้ง popup ลิงก์ทันที (ไม่ต้องเลื่อนไปกด 🔗)
        copyLink(added[0])
      } else {
        setFlash({ msg: `✅ เพิ่ม ${added.length} ออเดอร์แล้ว — แก้ไขในตารางได้เลย`, ok: true })
      }
    }
  }

  // เพิ่มแถวว่างไว้พิมพ์เองในตาราง
  async function addEmptyRow() {
    const blank = { tiktok: '', qty: 1, type: '', date: filterDate || '', name: '', phone: '', addr: '', note: '-' }
    await saveOrders([blank])
  }

  // แก้ค่าในตาราง (พิมพ์ทับได้เลย)
  function updateField(id, field, value) {
    setOrders((prev) => prev.map((x) => (x.id === id ? { ...x, [field]: value } : x)))
  }
  async function saveField(id, field, rawValue) {
    if (!online) return
    const colMap = { date: 'send_date' }
    const col = colMap[field] || field
    const val = field === 'qty' ? parseInt(rawValue) || 1 : rawValue
    await supabase.from(TABLE).update({ [col]: val }).eq('id', id)
  }
  // ยืนยันก่อนบันทึกการแก้ไข (กันเผลอกดช่องแล้วพิมพ์ทับ)
  const FIELD_LABELS = { tiktok: 'ชื่อ TikTok', qty: 'จำนวน', note: 'หมายเหตุ', date: 'วันส่ง', name: 'ชื่อจริง', addr: 'ที่อยู่', phone: 'เบอร์', tracking: 'เลขพัสดุ' }
  const editRef = useRef({})
  function cellFocus(id, field, value) {
    editRef.current = { id, field, value: value ?? '' }
  }
  function cellBlur(id, field, value) {
    const o = editRef.current
    editRef.current = {}
    if (!o || o.id !== id || o.field !== field) return
    if (String(o.value) === String(value)) return // ไม่ได้เปลี่ยน = ไม่ต้องถาม
    const label = FIELD_LABELS[field] || field
    if (confirm(`ยืนยันแก้ "${label}" เป็น "${value || '(ว่าง)'}" ?`)) {
      saveField(id, field, value)
    } else {
      updateField(id, field, o.value) // ยกเลิก → คืนค่าเดิม
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
    const link = `${SITE_URL}/ord/${code}`
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

  // ตัดคำนำหน้า + วรรณยุกต์เพี้ยน + ตัวคล้าย เพื่อเทียบชื่อแบบยืดหยุ่น
  const digitsOf = (s) => (s || '').replace(/\D/g, '')
  const last9 = (s) => {
    const d = digitsOf(s)
    return d.length >= 9 ? d.slice(-9) : d
  }
  const normName = (s) =>
    (s || '')
      .replace(/นางสาว|น\.ส\.?|นส\.?|นาง|นาย|คุณ|ร้าน/g, '')
      .replace(/[\u0E48-\u0E4E\u0E31\u0E47]/g, '') // วรรณยุกต์/ไม้ไต่คู้/นิคหิต
      .replace(/ฎ/g, 'ฏ')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, '')
      .trim()
  // เทียบชื่อ: สั้น (<4) ต้องตรงเป๊ะ กันจับมั่ว, ยาวใช้ contains ได้
  const nameHit = (a, b) => {
    if (!a || !b) return false
    if (a === b) return true
    if (a.length >= 4 && b.length >= 4) return a.includes(b) || b.includes(a)
    return false
  }

  // จับคู่เลขพัสดุ Flash (เบอร์ 9 หลักท้าย → ชื่อยืดหยุ่น) + เก็บรายการจับไม่ได้ไว้จับมือ
  async function importTracking() {
    if (!trackText.trim()) {
      setFlash({ msg: 'วางข้อมูลจากไฟล์ Flash ก่อนนะคะ', ok: false })
      return
    }
    const lines = trackText.split('\n').map((l) => l.trim()).filter(Boolean)
    const next = orders.map((o) => ({ ...o }))
    const used = new Set()
    const changed = []
    let matched = 0
    const missedRows = []
    lines.forEach((line) => {
      const tk = (line.match(/TH[0-9A-Z]{8,}/i) || [])[0]
      if (!tk) return
      const rest = line.replace(tk, ' ')
      const tokens = rest.split(/\s+/).filter(Boolean)
      const phoneIdx = tokens.findIndex((t) => {
        const d = digitsOf(t)
        return d.length >= 9 && d.length <= 10
      })
      const flashPhone = phoneIdx >= 0 ? last9(tokens[phoneIdx]) : ''
      let nameTokens = phoneIdx > 0 ? tokens.slice(0, phoneIdx) : tokens
      nameTokens = nameTokens.filter((t, i) => !(i === 0 && /^\d{1,3}$/.test(t)))
      const rawName = nameTokens.join(' ')
      const nn = normName(rawName)
      let idx = -1
      if (flashPhone) idx = next.findIndex((o, i) => !used.has(i) && last9(o.phone) === flashPhone)
      if (idx < 0 && nn) idx = next.findIndex((o, i) => !used.has(i) && nameHit(normName(o.name), nn))
      if (idx < 0) {
        missedRows.push({ tk, name: rawName })
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
    setUnmatched(missedRows)
    setFlash({
      msg: `📦 จับคู่ได้ ${matched} รายการ${missedRows.length ? ` · จับไม่ได้ ${missedRows.length} (เลือกเจ้าของด้านล่าง)` : ''}`,
      ok: matched > 0,
    })
    if (matched > 0) setTrackText('')
  }

  // จับมือ: เลือกออเดอร์ให้เลขพัสดุที่ระบบจับไม่ได้
  async function manualMatch(orderId, tk) {
    setOrders((prev) => prev.map((x) => (x.id === orderId ? { ...x, tracking: tk, status: 'ส่งแล้ว' } : x)))
    setUnmatched((prev) => prev.filter((u) => u.tk !== tk))
    if (online) {
      await supabase.from(TABLE).update({ tracking: tk, status: 'ส่งแล้ว' }).eq('id', orderId)
    }
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

  function markCopied(key) {
    setCopiedBtn(key)
    setTimeout(() => setCopiedBtn(''), 1000)
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
      markCopied(withAddr ? 'addr' : 'summary')
    } catch {
      setFlash({ msg: 'คัดลอกอัตโนมัติไม่ได้ — กดค้างในช่องข้างล่างแล้วก๊อปเองได้', ok: false })
    }
  }

  // กำลังเช็กว่าล็อกอินค้างไว้ไหม
  if (!authChecked) {
    return (
      <div className="lock-wrap">
        <div className="lock-card">
          <div className="lock-snail">🐌</div>
          <p>กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  if (!unlocked) {
    return (
      <div className="lock-wrap">
        <div className="lock-card">
          <div className="lock-snail">🐌</div>
          <h1>SnailShop</h1>
          <p>สำหรับพนักงานเท่านั้น</p>
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setLockErr(false) }}
            placeholder="อีเมลพนักงาน"
            autoComplete="username"
            autoFocus
          />
          <input
            type="password"
            value={pw}
            onChange={(e) => { setPw(e.target.value); setLockErr(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') tryUnlock() }}
            placeholder="รหัสผ่าน"
            autoComplete="current-password"
          />
          {lockErr && <div className="lock-err">อีเมลหรือรหัสผ่านไม่ถูกต้อง ลองใหม่นะคะ</div>}
          <button className="btn btn-primary" onClick={tryUnlock} disabled={loggingIn}>
            {loggingIn ? 'กำลังเข้าสู่ระบบ...' : 'เข้าใช้งาน'}
          </button>
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
          <p className="hint">วางข้อความ 2 ช่อง แล้วกดเข้าตารางเลย · แก้ตัวเลข/ข้อมูลในตารางได้ทีหลัง</p>

          <div className="paste-wrap">
            <label>1) ส่วนสรุป (แอค / จำนวน / วันส่ง)</label>
            <textarea
              value={pSummary}
              onChange={(e) => setPSummary(e.target.value)}
              placeholder={'ขอบคุณมากค่ะ\nแอคเค้าตต : ...\nสถานะ : ... ชุด\nส่งของวันที่ : 16/09'}
            />
            <label style={{ marginTop: 12 }}>2) ที่อยู่ลูกค้า (ชื่อ / เบอร์ / ที่อยู่)</label>
            <textarea
              value={pAddr}
              onChange={(e) => setPAddr(e.target.value)}
              placeholder={'ชื่อจริง เบอร์\nที่อยู่เต็ม + รหัสไปรษณีย์'}
            />
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={addFromBoxes}>➕ เพิ่มลงตารางเลย</button>
            <p className="parsed-flash" style={{ color: flash.ok ? 'var(--ok)' : 'var(--pink-deep)' }}>{flash.msg}</p>
            <p className="mini-clear" onClick={() => { setPSummary(''); setPAddr(''); setFlash({ msg: '', ok: true }) }}>ล้างช่องวาง</p>
          </div>

          <div className="divider">หรือ</div>
          <button className="btn btn-ghost" style={{ width: '100%' }} onClick={addEmptyRow}>➕ เพิ่มแถวว่าง (พิมพ์เองในตาราง)</button>

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
              <button className="btn btn-ghost btn-sm" style={copiedBtn === 'addr' ? { background: 'var(--ok)', color: '#fff', borderColor: 'var(--ok)' } : undefined} onClick={() => copyForPrint(true)}>
                {copiedBtn === 'addr' ? '✓ คัดลอกแล้ว' : '📋 คัดลอก (มีที่อยู่)'}
              </button>
              <button className="btn btn-ghost btn-sm" style={copiedBtn === 'summary' ? { background: 'var(--ok)', color: '#fff', borderColor: 'var(--ok)' } : undefined} onClick={() => copyForPrint(false)}>
                {copiedBtn === 'summary' ? '✓ คัดลอกแล้ว' : '📋 คัดลอก (สรุป)'}
              </button>
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

          {unmatched.length > 0 && (
            <div className="copy-box no-print" style={{ borderColor: 'var(--pink-deep)' }}>
              <div className="copy-head">
                <span>📦 จับไม่ได้ {unmatched.length} — เลือกเจ้าของเอง</span>
                <button className="mini-x" onClick={() => setUnmatched([])}>✕ ปิด</button>
              </div>
              {unmatched.map((u) => (
                <div key={u.tk} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700 }}>{u.tk}</span>
                  {u.name && <span style={{ fontSize: 12, color: 'var(--muted)' }}>({u.name})</span>}
                  <select className="status-select" defaultValue="" onChange={(e) => { if (e.target.value) manualMatch(e.target.value, u.tk) }}>
                    <option value="">— เลือกออเดอร์ —</option>
                    {orders.filter((o) => !o.tracking).map((o) => (
                      <option key={o.id} value={o.id}>{(o.tiktok || o.name || '?') + ' · ' + (o.phone || 'ไม่มีเบอร์')}</option>
                    ))}
                  </select>
                </div>
              ))}
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
                        <input className="cell-input" value={o.tiktok || ''} placeholder="—"
                          onChange={(e) => updateField(o.id, 'tiktok', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'tiktok', e.target.value)} onBlur={(e) => cellBlur(o.id, 'tiktok', e.target.value)} />
                        <input className="cell-input" style={{ fontSize: 11, color: '#0a7a3f', fontWeight: 600 }}
                          value={o.tracking || ''} placeholder="📦 เลขพัสดุ (วางเองได้)"
                          onChange={(e) => updateField(o.id, 'tracking', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'tracking', e.target.value)} onBlur={(e) => cellBlur(o.id, 'tracking', e.target.value)} />
                      </td>
                      <td>
                        <input className="cell-input cell-qty" type="number" min="1" value={o.qty}
                          onChange={(e) => updateField(o.id, 'qty', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'qty', e.target.value)} onBlur={(e) => cellBlur(o.id, 'qty', e.target.value)} />
                      </td>
                      <td>
                        <input className="cell-input" value={o.note === '-' ? '' : o.note || ''} placeholder="-"
                          onChange={(e) => updateField(o.id, 'note', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'note', e.target.value)} onBlur={(e) => cellBlur(o.id, 'note', e.target.value)} />
                      </td>
                      <td>
                        <input className="cell-input cell-date" value={o.date || ''} placeholder="—"
                          onChange={(e) => updateField(o.id, 'date', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'date', e.target.value)} onBlur={(e) => cellBlur(o.id, 'date', e.target.value)} />
                      </td>
                      <td>
                        <input className="cell-input" value={o.name || ''} placeholder="—"
                          onChange={(e) => updateField(o.id, 'name', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'name', e.target.value)} onBlur={(e) => cellBlur(o.id, 'name', e.target.value)} />
                      </td>
                      <td className="addr">
                        <textarea className="cell-input cell-addr" value={o.addr || ''} placeholder="—" rows={2}
                          onChange={(e) => updateField(o.id, 'addr', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'addr', e.target.value)} onBlur={(e) => cellBlur(o.id, 'addr', e.target.value)} />
                      </td>
                      <td>
                        <input className="cell-input" value={o.phone || ''} placeholder="—"
                          onChange={(e) => updateField(o.id, 'phone', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'phone', e.target.value)} onBlur={(e) => cellBlur(o.id, 'phone', e.target.value)} />
                      </td>
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
                style={{ flex: 1, ...(copiedBtn === 'link' ? { background: 'var(--ok)' } : {}) }}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(linkModal.link)
                    markCopied('link')
                  } catch {}
                }}
              >
                {copiedBtn === 'link' ? '✓ คัดลอกแล้ว' : '📋 คัดลอก'}
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
