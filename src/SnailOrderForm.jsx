import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import { supabase, TABLE, STATUSES, genOrderCode } from './supabase'
import NavSwitch from './NavSwitch.jsx'

// อีเมลเจ้าของหลัก — ใช้เช็กรหัสก่อน "ล้างรอบนี้" (ลบทีละเยอะ)
const OWNER_EMAIL = 'snailhausofficial@gmail.com'
// ตัวเช็กรหัสเจ้าของ: client แยก ไม่เก็บ session → คนที่ล็อกอินอยู่ไม่หลุด/ไม่สลับบัญชี
let ownerChecker = null
async function checkOwnerPassword(password) {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return true // โหมดทดลอง (ไม่ต่อฐานข้อมูล)
  if (!ownerChecker) {
    ownerChecker = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'snail-owner-check' },
    })
  }
  const { error } = await ownerChecker.auth.signInWithPassword({ email: OWNER_EMAIL, password })
  if (error) return false
  await ownerChecker.auth.signOut({ scope: 'local' })
  return true
}

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

// วันที่ส่ง → DD/MM เสมอ (1/11 กับ 01/11 = รอบเดียวกัน)
export function normDate(d) {
  const m = String(d || '').match(/^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/)
  return m ? m[1].padStart(2, '0') + '/' + m[2].padStart(2, '0') : String(d || '').trim()
}

// เรียงรอบส่ง ใหม่สุดขึ้นก่อน + แบ่งตามเดือน (เดาปีจากวันนี้ — ช่วงข้ามปี 05/01 อยู่เหนือ 28/12)
const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
export function roundInfo(d, today = new Date()) {
  const ty = today.getFullYear()
  const m = String(d || '').match(/^(\d{2})\/(\d{2})$/)
  if (!m) return { d, t: -Infinity, key: 'other', label: 'อื่นๆ' }
  const day = +m[1], mon = +m[2] - 1
  let y = ty
  const diff = mon - today.getMonth()
  if (diff > 2) y = ty - 1 // เดือนที่ "ล่วงหน้าเกิน 2 เดือน" = ของปีที่แล้ว
  else if (diff < -9) y = ty + 1 // ธ.ค. มองไป ม.ค. = ปีหน้า
  const label = TH_MONTHS[mon] + (y !== ty ? ' ' + (y + 543) : '')
  return { d, t: new Date(y, mon, day).getTime(), key: y + '-' + mon, label }
}
export function groupRounds(dates, today = new Date()) {
  const items = dates.map((d) => roundInfo(d, today))
  items.sort((a, b) => b.t - a.t)
  const groups = []
  items.forEach((it) => {
    const g = groups[groups.length - 1]
    if (g && g.key === it.key) g.dates.push(it.d)
    else groups.push({ key: it.key, label: it.label, dates: [it.d] })
  })
  return groups
}

// คำนำหน้าชื่อ (นับรวมกับชื่อ ไม่นับเป็นคำของชื่อ)
const NAME_PREFIX = /^(นาย|นางสาว|นาง|น\.ส\.?|คุณ|ด\.ช\.?|ด\.ญ\.?|เด็กชาย|เด็กหญิง|Mr\.?|Mrs\.?|Ms\.?|Miss)$/i
const POSTCODE = /(?<!\d)\d{5}(?!\d)/g

// เอาคำต้นๆ เป็นชื่อ (คำนำหน้า + ชื่อ + นามสกุล) ที่เหลือคืนกลับ
function takeName(str) {
  const w = str.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < w.length && NAME_PREFIX.test(w[i].replace(/[:：]/g, ''))) i++
  const end = Math.min(w.length, i + 2)
  return [w.slice(0, end).join(' '), w.slice(end).join(' ')]
}

// แยกชื่อ/ที่อยู่ เมื่อไม่มีป้าย "ที่อยู่"
// 1) ชื่ออยู่หน้า ตามด้วยคำบอกที่อยู่ (เลขที่/หมู่/ซอย/ต./อ./จ. ...)
//    — ถ้าข้างหน้ามีแต่ตัวเลข = บ้านเลขที่ ไม่ใช่ชื่อ (เช่น "50 ซอยรามอินทรา...")
// 2) ชื่ออยู่ท้ายสุด หลังรหัสไปรษณีย์ เช่น "... 74120 พีรยา สาธรณ์"
// 3) ไม่มีคำบอกที่อยู่เลย แต่มีรหัสไปรษณีย์ → 2 คำแรก = ชื่อ ที่เหลือ = ที่อยู่
function splitNameAddr(clean, ADDR_KW) {
  const text = clean.replace(/\s{2,}/g, ' ').trim()
  const pcs = [...text.matchAll(POSTCODE)]
  const lastPc = pcs[pcs.length - 1]
  const akw = text.match(ADDR_KW)
  const kwAt = akw ? text.indexOf(akw[0]) : -1
  let name = ''
  let addr = ''
  let guessed = false
  if (kwAt >= 0) {
    name = text.slice(0, kwAt)
    addr = text.slice(kwAt)
    if (!/[ก-๙a-zA-Z]/.test(name)) {
      addr = text // ข้างหน้ามีแต่ตัวเลข/เครื่องหมาย = บ้านเลขที่
      name = ''
    }
  } else if (lastPc) {
    ;[name, addr] = takeName(text)
    guessed = true // ไม่มีคำบอกที่อยู่ → เดาจาก 2 คำแรก
  } else return [text, '', false]

  // ไม่มีชื่อข้างหน้า → ดูว่ามีชื่อต่อท้ายรหัสไปรษณีย์ไหม
  if (!name.replace(/ชื่อ|ผู้รับ|[:：,]/g, '').trim() && lastPc) {
    const pcEnd = addr.lastIndexOf(lastPc[0]) + lastPc[0].length
    const tail = addr.slice(pcEnd).replace(/^[\s,.]+/, '')
    if (/[ก-๙a-zA-Z]{2,}/.test(tail)) {
      name = tail
      addr = addr.slice(0, pcEnd)
    }
  }
  // ชื่อยาวเกิน (มีที่อยู่ปนมา) → ตัดเหลือชื่อ+นามสกุล ที่เหลือย้ายไปหน้าที่อยู่
  const nm = name.replace(/ชื่อ|ผู้รับ|[:：]/g, ' ').trim()
  const [n2, rest] = takeName(nm)
  if (rest && lastPc) {
    name = n2
    addr = rest + ' ' + addr
    guessed = true
  }
  return [name, addr, guessed]
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
  // หมายเหตุ = อุปกรณ์หลัง "+" — ตัด "รส/รวมส่ง" · 401 / กาว401 / กาว 401 → "กาว 401"
  let noteRaw = statusLine.replace(/สถานะ|จำนวน/g, '').replace(/[:：]/, '')
  if (qm) noteRaw = noteRaw.replace(qm[0], ' ')
  // บรรทัดที่ขึ้นต้นด้วย + (เช่น "+ กล่องใส") นับเป็นหมายเหตุด้วย
  lines.forEach((l) => { if (l !== statusLine && /^[+＋]/.test(l)) noteRaw += ' + ' + l })
  noteRaw = noteRaw.replace(/รวมส่ง|รส\.?/g, ' + ').replace(/(?:กาว\s*)?(?<!\d)401(?!\d)/g, ' + กาว 401 + ')
  let parts = noteRaw
    .split(/[+＋*,]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^ชุด$/.test(s) && !/^\d+$/.test(s))
  o.note = parts.length ? [...new Set(parts)].join(', ') : '-'

  // วันที่ส่ง (รองรับ ส่งของวันที่/ส่งวันที่/จัดส่ง/นัดส่ง — ต้องมี DD/MM ในบรรทัดเดียวกัน)
  let dateLine =
    lines.find(
      (l) => /(ส่ง.*วันที่|วันที่ส่ง|วันส่ง|ส่งของ|จัดส่ง|นัดส่ง|รอบส่ง)/.test(l) && /\d{1,2}\s*\/\s*\d{1,2}/.test(l)
    ) || ''
  let dm = dateLine.match(/(\d{1,2})\s*\/\s*(\d{1,2})/)
  if (dm) o.date = normDate(dm[1] + '/' + dm[2])

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
      if (!name.trim()) [name, addr, o.guess] = splitNameAddr(after, ADDR_KW)
      else addr = after
    } else [name, addr, o.guess] = splitNameAddr(clean, ADDR_KW)
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

// โลโก้ร้าน (ไฟล์อยู่ที่ public/logo.png)
const LOGO = '/logo.png'

/* ================= จับคู่เลขพัสดุ ================= */
// ไปรษณีย์ไทย: 2 ตัวอักษร + 9 หลัก + TH — อ่านได้แม้มีเว้นวรรค เช่น "OB 3877 8148 7 TH"
const THPOST_RE = /\b[A-Z]{2}(?:\s*\d){9}\s*TH\b/i
// Flash: TH + ตัวอักษร/เลขติดกัน เช่น TH27229622KU7F
const FLASH_RE = /\bTH[0-9A-Z]{8,}\b/i

// บอกว่าเลขพัสดุเป็นของขนส่งเจ้าไหน (ดูจากรูปแบบเลข)
export function carrierOf(tk) {
  const t = (tk || '').replace(/\s/g, '').toUpperCase()
  if (/^(JD|E[A-Z])\d{9}TH$/.test(t)) return 'ไปรษณีย์ไทย (EMS)'
  if (/^[A-Z]{2}\d{9}TH$/.test(t)) return 'ไปรษณีย์ไทย'
  if (/^TH[0-9A-Z]{8,}$/.test(t)) return 'Flash'
  return ''
}
const isThaiPost = (tk) => carrierOf(tk).startsWith('ไปรษณีย์ไทย')

// ลิงก์หน้าเช็กสถานะของขนส่ง (ใส่เลขพัสดุให้แล้ว) — ต้องตรงกับ trackUrlOf ใน OrderStatus.jsx
export function trackUrlOf(tk) {
  const t = (tk || '').replace(/\s/g, '').toUpperCase()
  const c = carrierOf(t)
  if (c === 'Flash') return 'https://www.flashexpress.co.th/fle/tracking?se=' + encodeURIComponent(t)
  if (c.startsWith('ไปรษณีย์ไทย')) return 'https://track.thailandpost.co.th/?trackNumber=' + encodeURIComponent(t)
  return ''
}

const digitsOf = (s) => (s || '').replace(/\D/g, '')
const last9 = (s) => {
  const d = digitsOf(s)
  return d.length >= 9 ? d.slice(-9) : d
}

// ตัวอักษรเสียงเดียวกันให้ถือเป็นตัวเดียวกัน (สะกดต่างนิดหน่อยก็ยังจับได้)
const SAME_SOUND = { ณ: 'น', ศ: 'ส', ษ: 'ส', ฎ: 'ด', ฏ: 'ต', ฐ: 'ท', ฑ: 'ท', ฒ: 'ท', ธ: 'ท', ภ: 'พ', ฬ: 'ล', ฆ: 'ค', ฌ: 'ช' }

// แตกข้อความเป็น "คำ" — อ่านแค่ตัวอักษร ไม่สนตัวเลข : . และสัญลักษณ์อื่น
export function wordsOf(text) {
  return (text || '')
    .split(/[^\u0E01-\u0E4Ea-zA-Z]+/)
    .map((w) => w.replace(/^(นางสาว|นาง|นาย|คุณ)(?=.{2,})/, '')) // คำนำหน้าชื่อ
    .map((w) =>
      w
        .toLowerCase()
        .replace(/[\u0E31\u0E47-\u0E4E]/g, '') // ไม้หันอากาศ วรรณยุกต์ การันต์
        .replace(/[ณศษฎฏฐฑฒธภฬฆฌ]/g, (c) => SAME_SOUND[c])
    )
    .filter((w) => w.length >= 2)
}

// ต่างกันไม่เกิน 1 ตัวอักษร (เพิ่ม/ลบ/เปลี่ยน 1 ตัว)
function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let diff = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++diff > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else {
      i++
      j++
    }
  }
  return diff + (a.length - i) + (b.length - j) <= 1
}

function wordScore(a, b) {
  if (a === b) return 3 // ตรงเป๊ะ
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 2 // อยู่ในกัน เช่น ชื่อเล่นติดชื่อจริง
  if (a.length >= 4 && b.length >= 4 && within1(a, b)) return 1.5 // สะกดต่าง 1 ตัว
  return 0
}

// คะแนนความใกล้ระหว่าง "คำในบรรทัด" กับ ชื่อจริง + ชื่อ TikTok ของออเดอร์
export function nameScore(lineWords, o) {
  const target = [...wordsOf(o.name), ...wordsOf(o.tiktok)]
  let total = 0
  for (const a of lineWords) {
    let best = 0
    for (const b of target) best = Math.max(best, wordScore(a, b))
    total += best
  }
  return total
}
const MIN_SCORE = 1.5

// อ่าน 1 บรรทัด → เลขพัสดุ + เบอร์ (ถ้ามี) + คำที่น่าจะเป็นชื่อ
export function readTrackingLine(line) {
  let m = line.match(THPOST_RE) || line.match(FLASH_RE)
  if (!m) return null
  const tk = m[0].replace(/\s/g, '').toUpperCase()
  const rest = line.replace(m[0], ' ')
  // เบอร์โทร (มีในไฟล์ Flash) — ชื่ออยู่ก่อนเบอร์, หลังเบอร์มักเป็นที่อยู่ ไม่เอามาเทียบ
  const pm = rest.match(/(?<!\d)0?\d(?:[\s.\-]?\d){8}(?!\d)/)
  const phone = pm && digitsOf(pm[0]).length >= 9 ? last9(pm[0]) : ''
  const nameText = pm ? rest.slice(0, pm.index) : rest
  const words = wordsOf(nameText)
  return { tk, phone, words, label: nameText.replace(/[^\u0E01-\u0E4Ea-zA-Z\s]+/g, ' ').replace(/\s+/g, ' ').trim() }
}

// จับคู่ทั้งลิสต์ในรอบเดียว: คู่ที่คะแนนสูงสุดได้ก่อน, คะแนนเท่ากัน 2 คน = ไม่เดา
export function matchTracking(rows, orders, round) {
  const pool = orders
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => (o.date || '') === round)
  const pairs = []
  const ambiguous = new Set()
  rows.forEach((row, r) => {
    const cands = pool
      .filter(({ o }) => !o.tracking || o.tracking === row.tk)
      .map(({ o, i }) => {
        const phoneHit = row.phone && last9(o.phone) === row.phone
        return { r, i, score: (phoneHit ? 10 : 0) + nameScore(row.words, o) }
      })
      .filter((c) => c.score >= MIN_SCORE)
      .sort((x, y) => y.score - x.score)
    if (cands.length >= 2 && cands[0].score === cands[1].score) ambiguous.add(r)
    pairs.push(...cands)
  })
  pairs.sort((x, y) => y.score - x.score)
  const rowTo = new Map()
  const usedOrder = new Set()
  for (const p of pairs) {
    if (ambiguous.has(p.r) || rowTo.has(p.r) || usedOrder.has(p.i)) continue
    rowTo.set(p.r, p.i)
    usedOrder.add(p.i)
  }
  return rowTo // Map: ลำดับบรรทัด → ลำดับออเดอร์
}
/* ========================================================= */

const BLANK = { tiktok: '', qty: 1, type: '', date: '', name: '', phone: '', addr: '', note: '' }

// โดเมนหลักของเว็บ (ลิงก์ที่ส่งให้ลูกค้าจะใช้ตัวนี้เสมอ) — เปลี่ยนได้ที่นี่ หรือตั้ง env VITE_SITE_URL
const SITE_URL = import.meta.env.VITE_SITE_URL || 'https://order.snailshop.org'

// ===== เตือนข้อมูลไม่ครบ / น่าสงสัย (แถวสีเหลือง) =====
export function warnsOf(o) {
  const w = []
  const phones = String(o.phone || '').split('/').map((x) => x.replace(/\D/g, '')).filter(Boolean)
  if (!o.name || !o.name.trim()) w.push('ไม่มีชื่อ')
  else if (o.guess) w.push('ระบบเดาชื่อ')
  if (phones.length === 0) w.push('ไม่มีเบอร์')
  else if (phones.some((p) => p.length !== 10)) w.push('เบอร์ไม่ครบ 10 หลัก')
  if (!/(?<!\d)\d{5}(?!\d)/.test(o.addr || '')) w.push('ไม่มีรหัสไปรษณีย์')
  return w
}

// เบอร์ของออเดอร์ (9 หลักท้าย) — ใช้นับว่าเป็นลูกค้าคนเดียวกัน
export function phoneKeys(phone) {
  return String(phone || '')
    .split('/')
    .map((x) => x.replace(/\D/g, ''))
    .filter((d) => d.length >= 9)
    .map((d) => d.slice(-9))
}

// ค้นหาข้ามรอบ: ชื่อจริง / แอค TikTok / เบอร์ (หรือ 4 ตัวท้าย) / เลขพัสดุ
export function matchSearch(o, q) {
  const t = q.trim().toLowerCase()
  if (!t) return true
  const digits = t.replace(/[\s-]/g, '')
  if (/^\d{3,}$/.test(digits)) {
    const ph = String(o.phone || '').replace(/\D/g, '')
    if (ph.includes(digits)) return true
  }
  const hay = [o.tiktok, o.name, o.tracking, o.phone].join(' ').toLowerCase()
  return hay.includes(t) || hay.replace(/\s/g, '').includes(t.replace(/\s/g, ''))
}

// ===== สมุดบันทึก / ถังขยะ =====
const LOG_TABLE = 'order_log'
const LOG_FIELD_LABELS = {
  tiktok: 'ชื่อ TikTok', qty: 'จำนวน', note: 'หมายเหตุ', send_date: 'วันส่ง', name: 'ชื่อจริง', addr: 'ที่อยู่',
  phone: 'เบอร์', tracking: 'เลขพัสดุ', status: 'สถานะ', type: 'แบบ', code: 'เลขออเดอร์',
}
const LOG_ACTION_LABELS = { insert: '➕ สร้างออเดอร์', update: '✏️ แก้ไข', delete: '🗑️ ลบ', restore: '♻️ กู้คืน' }
export function fmtWhen(at) {
  const d = new Date(at)
  if (isNaN(d)) return '-'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB'
}
// รวมแถวที่ถูกลบพร้อมกัน (ล้างรอบ = เวลาเดียวกันเป๊ะ + คนเดียวกัน) เป็นกลุ่ม
export function groupTrash(rows) {
  const groups = []
  rows.forEach((r) => {
    const g = groups[groups.length - 1]
    if (g && g.at === r.at && g.actor === r.actor_email) g.rows.push(r)
    else groups.push({ at: r.at, actor: r.actor_email, rows: [r] })
  })
  return groups
}

const SORT_DEFAULT_DIR = { created: 'desc', qty: 'desc', tiktok: 'asc', status: 'asc' }

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
  const [search, setSearch] = useState('') // 🔍 ค้นหาข้ามรอบ
  const [sort, setSort] = useState({ key: 'created', dir: 'desc' }) // ลูกศรหัวตาราง (ใบปะหน้าไม่ตาม)
  const [historyOf, setHistoryOf] = useState(null) // 👤 ประวัติลูกค้า
  const [ownerModal, setOwnerModal] = useState(null) // 🔒 รหัสเจ้าของก่อนล้างรอบ
  const [trash, setTrash] = useState(null) // 🗑️ ถังขยะ: null = ปิด · { loading, groups, size, err }
  const [restoring, setRestoring] = useState(false)
  const [editLog, setEditLog] = useState(null) // 📝 ประวัติการแก้ของออเดอร์
  const [ownerPw, setOwnerPw] = useState('')
  const [ownerMsg, setOwnerMsg] = useState('')
  const [ownerBusy, setOwnerBusy] = useState(false)
  const [formHidden, setFormHidden] = useState(() => {
    try {
      return localStorage.getItem('snail.formHidden') === '1'
    } catch {
      return false
    }
  })
  function toggleForm() {
    setFormHidden((v) => {
      try {
        localStorage.setItem('snail.formHidden', v ? '0' : '1')
      } catch {}
      return !v
    })
  }
  // ===== ล็อกอินพนักงาน (Supabase Auth) =====
  const [unlocked, setUnlocked] = useState(false)
  const [authChecked, setAuthChecked] = useState(false) // เช็ก session เสร็จหรือยัง (กันหน้าล็อกกะพริบ)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [lockErr, setLockErr] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [linkModal, setLinkModal] = useState(null)
  // ===== เปลี่ยนรหัสผ่าน =====
  const [pwModal, setPwModal] = useState(false)
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [pwMsg, setPwMsg] = useState({ msg: '', ok: true })
  const [pwSaving, setPwSaving] = useState(false)

  // ชื่อแท็บของหน้าพนักงาน (หน้าลูกค้าใช้ชื่อจาก index.html)
  useEffect(() => {
    document.title = 'หลังร้าน Snail Shop'
  }, [])

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

  function openPwModal() {
    setNewPw('')
    setNewPw2('')
    setPwMsg({ msg: '', ok: true })
    setPwModal(true)
  }

  async function changePassword() {
    if (newPw.length < 8) {
      setPwMsg({ msg: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว', ok: false })
      return
    }
    if (newPw !== newPw2) {
      setPwMsg({ msg: 'รหัสผ่านสองช่องไม่ตรงกัน', ok: false })
      return
    }
    setPwSaving(true)
    const { error } = await supabase.auth.updateUser({ password: newPw })
    setPwSaving(false)
    if (error) {
      setPwMsg({ msg: 'เปลี่ยนไม่สำเร็จ: ' + error.message, ok: false })
      return
    }
    setNewPw('')
    setNewPw2('')
    setPwMsg({ msg: '✅ เปลี่ยนรหัสผ่านแล้ว ครั้งหน้าใช้รหัสใหม่ล็อกอินนะคะ', ok: true })
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
    date: normDate(r.send_date),
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

  async function loadOrders(pickLatest) {
    // Supabase ส่งได้ครั้งละไม่เกิน 1,000 แถว (ตั้ง Max rows ไว้) → โหลดทีละหน้าต่อกันจนครบ
    const PAGE = 1000
    const all = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from(TABLE)
        .select('*')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        setFlash({ msg: 'โหลดข้อมูลจากฐานข้อมูลไม่ได้: ' + error.message, ok: false })
        return
      }
      all.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
    const rows = all.map(fromRow)
    setOrders(rows)
    // ค่าเริ่มต้น: เลือกรอบส่งล่าสุด (จะได้ไม่ปนวันอื่น)
    const latest = rows.length ? rows[rows.length - 1].date : ''
    if (pickLatest && latest) setFilterDate(latest)
  }
  useEffect(() => {
    if (!online || !unlocked) return
    loadOrders(true)
  }, [online, unlocked])

  // ===== 🗑️ ถังขยะ: ออเดอร์ที่ถูกลบ (ยังไม่กู้) =====
  async function openTrash() {
    if (!online) {
      setFlash({ msg: 'ถังขยะใช้ได้เมื่อต่อฐานข้อมูลแล้วค่ะ', ok: false })
      return
    }
    setTrash({ loading: true, groups: [], size: null, err: '' })
    const [{ data, error }, sz] = await Promise.all([
      supabase
        .from(LOG_TABLE)
        .select('id,at,actor_email,order_id,code,send_date,before')
        .eq('action', 'delete')
        .is('restored_at', null)
        .order('at', { ascending: false })
        .order('id', { ascending: true })
        .limit(500),
      supabase.rpc('order_log_size'),
    ])
    if (error) {
      setTrash({ loading: false, groups: [], size: null, err: 'เปิดถังขยะไม่ได้: ' + error.message + ' (รัน SQL สมุดบันทึกใน Supabase แล้วหรือยัง?)' })
      return
    }
    setTrash({ loading: false, groups: groupTrash(data || []), size: sz?.data || null, err: '' })
  }
  async function restoreLogs(ids) {
    if (!ids.length) return
    if (!confirm(`กู้คืน ${ids.length} ออเดอร์? (กลับไปอยู่ในรอบเดิม ลิงก์เดิม)`)) return
    setRestoring(true)
    const { data, error } = await supabase.rpc('restore_orders', { p_log_ids: ids })
    setRestoring(false)
    if (error) {
      alert('กู้ไม่สำเร็จ: ' + error.message)
      return
    }
    await loadOrders(false)
    setFlash({ msg: `♻️ กู้คืนแล้ว ${data ?? ids.length} ออเดอร์`, ok: true })
    openTrash()
  }

  // ลบถาวร (กู้ไม่ได้อีก) — ลบบันทึกทั้งหมดของออเดอร์นั้นออกจากสมุด เพื่อคืนพื้นที่
  async function purgeLogs(ids) {
    if (!ids.length) return
    if (!confirm(`ลบถาวร ${ids.length} ออเดอร์?\nกู้คืนไม่ได้อีกนะคะ (ประวัติการแก้ของออเดอร์เหล่านี้จะหายไปด้วย)`)) return
    setRestoring(true)
    const { data, error } = await supabase.rpc('purge_trash', { p_log_ids: ids })
    setRestoring(false)
    if (error) {
      alert('ลบถาวรไม่สำเร็จ: ' + error.message + (/purge_trash/.test(error.message) ? '\n(รัน SQL ลบถาวรใน Supabase แล้วหรือยัง?)' : ''))
      return
    }
    setFlash({ msg: `🔥 ลบถาวรแล้ว ${data ?? ids.length} ออเดอร์`, ok: true })
    openTrash()
  }

  // ===== 📝 ประวัติการแก้ของออเดอร์ (ดูอย่างเดียว) =====
  async function openEditLog(o) {
    if (!online) {
      setFlash({ msg: 'ประวัติการแก้ใช้ได้เมื่อต่อฐานข้อมูลแล้วค่ะ', ok: false })
      return
    }
    const who = o.tiktok || o.name || '-'
    setEditLog({ who, loading: true, rows: [], err: '' })
    const { data, error } = await supabase
      .from(LOG_TABLE)
      .select('id,at,actor_email,action,before,after')
      .eq('order_id', String(o.id))
      .order('at', { ascending: false })
      .order('id', { ascending: false })
      .limit(200)
    if (error) {
      setEditLog({ who, loading: false, rows: [], err: 'โหลดไม่ได้: ' + error.message + ' (รัน SQL สมุดบันทึกใน Supabase แล้วหรือยัง?)' })
      return
    }
    setEditLog({ who, loading: false, rows: data || [], err: '' })
  }

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
    // guess (ระบบเดาชื่อ) ไม่ได้เก็บในฐานข้อมูล — ติดไว้ในหน้าจนกว่าจะแก้ชื่อหรือรีเฟรช
    const rows = (data || []).map((r, k) => ({ ...fromRow(r), guess: !!list[k]?.guess }))
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
        guess: !!o.guess,
      }))
    if (parsed.length === 0) {
      setFlash({ msg: 'แยกไม่ได้ ลองเช็กว่ามีบรรทัด “แอคเค้าตต” ไหม', ok: false })
      return
    }
    const added = await saveOrders(parsed)
    if (added.length > 0) {
      const d = parsed.find((o) => o.date)?.date
      if (d) setFilterDate(d)
      setSearch('')
      setSort({ key: 'created', dir: 'desc' }) // ให้คนที่เพิ่งกรอกอยู่บนสุด
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

  // ปุ่ม "วาง": เอาข้อความที่คัดลอกไว้มาใส่ช่อง (แทนของเดิม)
  async function pasteInto(setter) {
    try {
      const t = await navigator.clipboard.readText()
      if (!t || !t.trim()) {
        setFlash({ msg: 'คลิปบอร์ดว่างอยู่ค่ะ — คัดลอกข้อความมาก่อนนะคะ', ok: false })
        return
      }
      setter(t)
      setFlash({ msg: '', ok: true })
    } catch {
      setFlash({ msg: 'เครื่องนี้ไม่ให้กดวางอัตโนมัติ — กดค้างในช่องแล้วเลือก "วาง" แทนนะคะ', ok: false })
    }
  }

  // เพิ่มแถวว่างไว้พิมพ์เองในตาราง
  async function addEmptyRow() {
    const blank = { tiktok: '', qty: 1, type: '', date: isRound ? filterDate : '', name: '', phone: '', addr: '', note: '-' }
    await saveOrders([blank])
  }

  // แก้ค่าในตาราง (พิมพ์ทับได้เลย)
  function updateField(id, field, value) {
    setOrders((prev) => prev.map((x) => (x.id === id ? { ...x, [field]: value } : x)))
  }
  async function saveField(id, field, rawValue) {
    if (field === 'name') updateField(id, 'guess', false)
    if (!online) return
    const colMap = { date: 'send_date' }
    const col = colMap[field] || field
    const val = field === 'qty' ? parseInt(rawValue) || 1 : field === 'date' ? normDate(rawValue) : rawValue
    if (field === 'date' && val !== rawValue) updateField(id, 'date', val)
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

  // ล้างรอบนี้ → ต้องใส่รหัสผ่านของเจ้าของหลักก่อน (กันมือบอน/เผลอกด)
  function clearRound() {
    if (!isRound) {
      setFlash({ msg: 'ล้างได้ทีละรอบเท่านั้น — เลือกรอบส่งก่อนนะคะ', ok: false })
      return
    }
    const ids = orders.filter((o) => (o.date || '') === filterDate).map((o) => o.id)
    if (ids.length === 0) return
    setOwnerPw('')
    setOwnerMsg('')
    setOwnerModal({ ids, label: filterDate })
  }
  async function confirmClearRound() {
    if (!ownerModal) return
    if (!ownerPw) {
      setOwnerMsg('ใส่รหัสผ่านของเจ้าของก่อนนะคะ')
      return
    }
    setOwnerBusy(true)
    const ok = await checkOwnerPassword(ownerPw)
    if (!ok) {
      setOwnerBusy(false)
      setOwnerMsg('รหัสผ่านไม่ถูกต้อง — ไม่ได้ลบอะไร')
      return
    }
    const { ids, label } = ownerModal
    if (online) {
      const { error } = await supabase.from(TABLE).delete().in('id', ids)
      if (error) {
        setOwnerBusy(false)
        setOwnerMsg('ล้างไม่สำเร็จ: ' + error.message)
        return
      }
    }
    setOwnerBusy(false)
    setOrders((prev) => prev.filter((o) => !ids.includes(o.id)))
    setOwnerModal(null)
    setOwnerPw('')
    setFlash({ msg: `🗑️ ล้างรอบส่ง ${label} แล้ว (${ids.length} รายการ)`, ok: true })
  }

  async function importTracking() {
    if (!trackText.trim()) {
      setFlash({ msg: 'วางลิสต์เลขพัสดุ (Flash หรือไปรษณีย์ไทย) ก่อนนะคะ', ok: false })
      return
    }
    if (!isRound) {
      setFlash({ msg: 'เลือกรอบส่งก่อนนะคะ — ระบบจะจับคู่เฉพาะในรอบนั้น ไม่จับข้ามรอบ', ok: false })
      return
    }
    const round = filterDate
    const rows = trackText.split('\n').map((l) => readTrackingLine(l.trim())).filter(Boolean)
    if (rows.length === 0) {
      setFlash({ msg: 'ไม่เจอเลขพัสดุในข้อความเลยค่ะ ลองเช็กอีกที', ok: false })
      return
    }
    const next = orders.map((o) => ({ ...o }))
    const rowTo = matchTracking(rows, next, round)
    const changed = []
    const missedRows = []
    rows.forEach((row, r) => {
      if (!rowTo.has(r)) {
        missedRows.push({ tk: row.tk, name: row.label, words: row.words, phone: row.phone, round })
        return
      }
      const o = next[rowTo.get(r)]
      o.tracking = row.tk
      o.status = 'ส่งแล้ว'
      changed.push(o)
    })
    const matched = changed.length
    setOrders(next)
    if (online) {
      for (const o of changed) {
        await supabase.from(TABLE).update({ tracking: o.tracking, status: o.status }).eq('id', o.id)
      }
    }
    setUnmatched(missedRows)
    const nPost = changed.filter((o) => isThaiPost(o.tracking)).length
    const nFlash = changed.filter((o) => carrierOf(o.tracking) === 'Flash').length
    const byCarrier = [nPost ? `ไปรษณีย์ไทย ${nPost}` : '', nFlash ? `Flash ${nFlash}` : ''].filter(Boolean).join(' · ')
    setFlash({
      msg: `📦 รอบ ${round}: จับคู่ได้ ${matched} รายการ${byCarrier ? ` (${byCarrier})` : ''}${missedRows.length ? ` · จับไม่ได้ ${missedRows.length} (เลือกเจ้าของด้านล่าง)` : ''}`,
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
  // filterDate: '' = ทุกวัน · 'DD/MM' = รอบส่ง · 'month:<ปี-เดือน>' = ทั้งเดือน
  const dates = [...new Set(orders.map((o) => o.date).filter(Boolean))]
  const roundGroups = groupRounds(dates).map((g) => {
    const inMonth = orders.filter((o) => g.dates.includes(o.date))
    return { ...g, count: inMonth.length, qty: inMonth.reduce((s, o) => s + (parseInt(o.qty) || 0), 0) }
  })
  const isMonth = filterDate.startsWith('month:')
  const searching = !!search.trim()
  const isRound = !!filterDate && !isMonth && !searching
  const monthGroup = isMonth ? roundGroups.find((g) => 'month:' + g.key === filterDate) : null
  // visible = ลำดับเดิม (ลำดับที่กรอก) → ใช้กับใบปะหน้า + คัดลอก Peripage
  const visible = searching
    ? orders.filter((o) => matchSearch(o, search))
    : isMonth
      ? orders.filter((o) => (monthGroup ? monthGroup.dates.includes(o.date) : false))
      : filterDate
        ? orders.filter((o) => (o.date || '') === filterDate)
        : orders
  const total = visible.reduce((s, o) => s + (parseInt(o.qty) || 0), 0)
  const roundLabel = searching
    ? `ผลค้นหา “${search.trim()}”`
    : isMonth
      ? `เดือน${monthGroup ? monthGroup.label : ''}`
      : filterDate
        ? `รอบส่ง ${filterDate}`
        : 'รอบส่ง ทั้งหมด'
  // สรุปรายรอบของเดือนที่เลือก
  const monthRounds = monthGroup
    ? monthGroup.dates.map((d) => {
        const os = orders.filter((o) => o.date === d)
        return { d, count: os.length, qty: os.reduce((s, o) => s + (parseInt(o.qty) || 0), 0) }
      })
    : []
  const glueCount = visible.filter((o) => /401/.test(o.note || '')).length

  // ===== เรียงในตาราง (กดหัวตาราง) — ใบปะหน้า/คัดลอก ยังเรียงตามลำดับเดิม =====
  const created = new Map(orders.map((o, i) => [o.id, i]))
  const tableRows = [...visible].sort((a, b) => {
    let r = 0
    if (sort.key === 'qty') r = (parseInt(a.qty) || 0) - (parseInt(b.qty) || 0)
    else if (sort.key === 'tiktok') r = String(a.tiktok || '').replace(/^@/, '').localeCompare(String(b.tiktok || '').replace(/^@/, ''), 'th')
    else if (sort.key === 'status') r = STATUSES.indexOf(a.status || STATUSES[0]) - STATUSES.indexOf(b.status || STATUSES[0])
    if (r === 0) r = (created.get(a.id) ?? 0) - (created.get(b.id) ?? 0)
    return sort.dir === 'asc' ? r : -r
  })
  function sortBy(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: SORT_DEFAULT_DIR[key] }))
  }
  function SortTh({ k, children, title }) {
    const on = sort.key === k
    return (
      <th className={'th-sort' + (on ? ' on' : '')} onClick={() => sortBy(k)} title={title || 'กดเพื่อเรียง'}>
        {children} <span className="sort-arrow">{on ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
      </th>
    )
  }

  // ===== 👤 ประวัติลูกค้า (นับคนเดียวกันจากเบอร์) =====
  function historyFor(o) {
    const keys = phoneKeys(o.phone)
    const byPhone = keys.length > 0
    const list = byPhone
      ? orders.filter((x) => phoneKeys(x.phone).some((k) => keys.includes(k)))
      : orders.filter((x) => o.tiktok && x.tiktok === o.tiktok)
    const sorted = [...list].sort((a, b) => {
      const r = roundInfo(b.date).t - roundInfo(a.date).t
      return r !== 0 ? r : (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0)
    })
    const accounts = [...new Set(list.map((x) => (x.tiktok || '').trim()).filter(Boolean))]
    const withDate = sorted.filter((x) => x.date)
    return {
      who: o.name || o.tiktok || '-',
      phone: o.phone,
      byPhone,
      list: sorted,
      accounts,
      qty: list.reduce((s, x) => s + (parseInt(x.qty) || 0), 0),
      first: withDate.length ? withDate[withDate.length - 1].date : '-',
      last: withDate.length ? withDate[0].date : '-',
    }
  }

  // สร้างข้อความสำหรับก๊อปไปวางในแอปปริ้น (เฉพาะรอบที่เลือก)
  function buildText(withAddr) {
    const date = isRound ? filterDate : isMonth ? roundLabel : visible.find((o) => o.date)?.date || ''
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
          <img src={LOGO} alt="Snail Shop" style={{ width: '100%', maxWidth: 200, display: 'block', margin: '0 auto 10px' }} />
          <p>กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  if (!unlocked) {
    return (
      <div className="lock-wrap">
        <div className="lock-card">
          <img src={LOGO} alt="Snail Shop" style={{ width: '100%', maxWidth: 220, display: 'block', margin: '0 auto 6px' }} />
          <div className="lock-title">หลังร้าน Snail Shop</div>
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
        <img src={LOGO} alt="Snail Shop" style={{ height: 44, background: '#fff', borderRadius: 12, padding: '4px 10px', display: 'block' }} />
        <div>
          <p>หลังร้าน Snail Shop</p>
        </div>
        <span className={'conn ' + (online ? 'on' : 'off')}>
          {online ? '● บันทึกลงฐานข้อมูล' : '○ โหมดทดลอง (ยังไม่ต่อฐานข้อมูล)'}
        </span>
        {online && (
          <button className="logout-btn no-print" onClick={openPwModal} title="เปลี่ยนรหัสผ่าน">🔑 เปลี่ยนรหัส</button>
        )}
        <button className="logout-btn no-print" onClick={logout} title="ออกจากระบบ">ออก</button>
      </header>
      {online && <NavSwitch active="orders" />}

      <div className={'wrap' + (formHidden ? ' wrap-wide' : '')}>
        {/* ===== FORM ===== */}
        {!formHidden && (
        <section className="card form-card no-print">
          <div className="form-head">
            <h2>➕ เพิ่มออเดอร์</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={toggleForm} title="ซ่อนฟอร์ม ให้ตารางเต็มจอ">◀ ซ่อนฟอร์ม</button>
          </div>
          <p className="hint">วางข้อความ 2 ช่อง แล้วกดเข้าตารางเลย · แก้ตัวเลข/ข้อมูลในตารางได้ทีหลัง</p>

          <div className="paste-wrap">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <label style={{ margin: 0 }}>1) ส่วนสรุป (แอค / จำนวน / วันส่ง)</label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => pasteInto(setPSummary)}>📋 วาง</button>
            </div>
            <textarea
              value={pSummary}
              onChange={(e) => setPSummary(e.target.value)}
              placeholder={'ขอบคุณมากค่ะ\nแอคเค้าตต : ...\nสถานะ : ... ชุด\nส่งของวันที่ : 16/09'}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12, marginBottom: 6 }}>
              <label style={{ margin: 0 }}>2) ที่อยู่ลูกค้า (ชื่อ / เบอร์ / ที่อยู่)</label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => pasteInto(setPAddr)}>📋 วาง</button>
            </div>
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
        )}

        {/* ===== TABLE ===== */}
        <section className="card no-print">
          <div className="list-head">
            <h2 style={{ margin: 0 }}>
              📋 {roundLabel} <span className="pill">{visible.length} ออเดอร์ · {total.toLocaleString()} ชุด</span>
            </h2>
            <div className="toolbar no-print">
              {formHidden && (
                <button className="btn btn-primary btn-sm" onClick={toggleForm}>▶ แสดงฟอร์ม (เพิ่มออเดอร์)</button>
              )}
              <select className="round-select" value={filterDate} onChange={(e) => { setFilterDate(e.target.value); setSearch('') }}>
                {roundGroups.map((g) => (
                  <optgroup key={g.key} label={`── ${g.label} · ${g.count.toLocaleString()} ออเดอร์ · ${g.qty.toLocaleString()} ชุด ──`}>
                    <option value={'month:' + g.key}>📅 ทั้งเดือน{g.label}</option>
                    {g.dates.map((d) => (
                      <option key={d} value={d}>รอบส่ง {d}</option>
                    ))}
                  </optgroup>
                ))}
                <option value="">ทุกวัน</option>
              </select>
              <button className="btn btn-ghost btn-sm" style={copiedBtn === 'addr' ? { background: 'var(--ok)', color: '#fff', borderColor: 'var(--ok)' } : undefined} onClick={() => copyForPrint(true)}>
                {copiedBtn === 'addr' ? '✓ คัดลอกแล้ว' : '📋 คัดลอก (มีที่อยู่)'}
              </button>
              <button className="btn btn-ghost btn-sm" style={copiedBtn === 'summary' ? { background: 'var(--ok)', color: '#fff', borderColor: 'var(--ok)' } : undefined} onClick={() => copyForPrint(false)}>
                {copiedBtn === 'summary' ? '✓ คัดลอกแล้ว' : '📋 คัดลอก (สรุป)'}
              </button>
              <button className="btn btn-ghost btn-sm" disabled={!isRound} title={isRound ? '' : 'ใช้ได้ทีละรอบ — เลือกรอบส่งก่อน'} onClick={() => setShowTrack((v) => !v)}>📦 ใส่เลขพัสดุ</button>
              <button className="btn btn-ghost btn-sm" onClick={printLabels}>🖨️ ปริ้นใบปะหน้า</button>
              <button className="btn btn-ghost btn-sm" disabled={!isRound} title={isRound ? 'ต้องใส่รหัสเจ้าของ' : 'ใช้ได้ทีละรอบ — เลือกรอบส่งก่อน'} onClick={clearRound}>🗑️ ล้างรอบนี้ 🔒</button>
              <button className="btn btn-ghost btn-sm" onClick={openTrash} title="ออเดอร์ที่ถูกลบ — กู้คืนได้">♻️ ถังขยะ</button>
            </div>
          </div>

          <div className="search-row no-print">
            <input
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 ค้นหาทุกรอบ — ชื่อ / แอค TikTok / เบอร์ (4 ตัวท้ายก็ได้) / เลขพัสดุ"
            />
            {searching && <button className="btn btn-ghost btn-sm" onClick={() => setSearch('')}>✕ ล้างคำค้น</button>}
          </div>

          {isMonth && monthGroup && !searching && (
            <div className="month-box no-print">
              <div className="month-sum">
                📅 เดือน{monthGroup.label}: <b>{monthGroup.count.toLocaleString()}</b> ออเดอร์ · <b>{monthGroup.qty.toLocaleString()}</b> ชุด · มีกาว 401 <b>{glueCount.toLocaleString()}</b> ออเดอร์
              </div>
              <div className="month-rounds">
                {monthRounds.map((r) => (
                  <button key={r.d} className="month-round" onClick={() => setFilterDate(r.d)} title="เปิดรอบนี้">
                    <b>{r.d}</b> {r.count} ออเดอร์ · {r.qty.toLocaleString()} ชุด
                  </button>
                ))}
              </div>
            </div>
          )}

          {showTrack && isRound && (
            <div className="copy-box no-print">
              <div className="copy-head">
                <span>วางลิสต์เลขพัสดุ — Flash (เลข + ชื่อ + เบอร์) หรือ ไปรษณีย์ไทย (ชื่อ TikTok + เลข)</span>
                <button className="mini-x" onClick={() => setShowTrack(false)}>✕ ปิด</button>
              </div>
              <textarea
                value={trackText}
                onChange={(e) => setTrackText(e.target.value)}
                placeholder={'ตัวอย่าง Flash (ก๊อปจาก Excel ทั้งแถวได้):\nTH010395VG1X0C\tคุณวิลาวัลย์\t0853288992\n\nตัวอย่าง ไปรษณีย์ไทย:\nฟ้า OB387781306TH'}
              />
              <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={importTracking}>🔗 จับคู่เลขพัสดุ</button>
            </div>
          )}

          {unmatched.length > 0 && (
            <div className="copy-box no-print" style={{ borderColor: 'var(--pink-deep)' }}>
              <div className="copy-head">
                <span>📦 จับไม่ได้ {unmatched.length} (รอบ {unmatched[0].round}) — เลือกเจ้าของเอง</span>
                <button className="mini-x" onClick={() => setUnmatched([])}>✕ ปิด</button>
              </div>
              {unmatched.map((u) => (
                <div key={u.tk} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700 }}>{u.tk}</span>
                  {carrierOf(u.tk) && <span style={{ fontSize: 11, color: 'var(--pink-deep)' }}>🚚 {carrierOf(u.tk)}</span>}
                  {u.name && <span style={{ fontSize: 12, color: 'var(--muted)' }}>({u.name})</span>}
                  <select className="status-select" defaultValue="" onChange={(e) => { if (e.target.value) manualMatch(e.target.value, u.tk) }}>
                    <option value="">— เลือกออเดอร์ —</option>
                    {orders
                      .filter((o) => (o.date || '') === u.round && !o.tracking)
                      .map((o) => ({ o, s: (u.phone && last9(o.phone) === u.phone ? 10 : 0) + nameScore(u.words || [], o) }))
                      .sort((x, y) => y.s - x.s)
                      .map(({ o, s }) => (
                        <option key={o.id} value={o.id}>
                          {(s >= MIN_SCORE ? '⭐ ' : '') + [o.tiktok || '-', o.name || '-', o.phone || 'ไม่มีเบอร์'].join(' · ')}
                        </option>
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
              <img src={LOGO} alt="Snail Shop" style={{ width: 140, maxWidth: '60%', display: 'block', margin: '0 auto 8px', opacity: 0.85 }} />
              {searching ? 'ไม่เจอออเดอร์ที่ตรงกับคำค้น' : 'ยังไม่มีออเดอร์ในรอบนี้ — กรอกฟอร์มด้านซ้าย หรือเลือกรอบส่งอื่น'}
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="th-sort th-order" onClick={() => sortBy('created')} title="เรียงตามลำดับที่กรอก">
                      # <span className="sort-arrow">{sort.key === 'created' ? (sort.dir === 'desc' ? '▼' : '▲') : '⇅'}</span>
                    </th>
                    <SortTh k="tiktok">ชื่อ TikTok</SortTh><SortTh k="qty">จำนวน</SortTh><th>หมายเหตุ</th><th>วันส่ง</th>
                    <th>ชื่อจริง</th><th>ที่อยู่</th><th>เบอร์</th>
                    <SortTh k="status">สถานะ</SortTh><th className="no-print">ลิงก์</th><th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((o, i) => {
                    const warns = warnsOf(o)
                    return (
                    <tr key={o.id ?? i} className={warns.length ? 'row-warn' : ''}>
                      <td className="c-order" title="ลำดับที่กรอก (1 = เก่าสุด)">{(created.get(o.id) ?? 0) + 1}</td>
                      <td className="acc">
                        <input className="cell-input" value={o.tiktok || ''} placeholder="—"
                          onChange={(e) => updateField(o.id, 'tiktok', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'tiktok', e.target.value)} onBlur={(e) => cellBlur(o.id, 'tiktok', e.target.value)} />
                        <input className="cell-input" style={{ fontSize: 11, color: '#0a7a3f', fontWeight: 600 }}
                          value={o.tracking || ''} placeholder="📦 เลขพัสดุ (วางเองได้)"
                          onChange={(e) => updateField(o.id, 'tracking', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'tracking', e.target.value)} onBlur={(e) => cellBlur(o.id, 'tracking', e.target.value)} />
                        {carrierOf(o.tracking) && (
                          <a
                            href={trackUrlOf(o.tracking)}
                            target="_blank"
                            rel="noreferrer"
                            title="เปิดหน้าเช็กสถานะของขนส่ง"
                            style={{ display: 'block', fontSize: 10, color: '#0a7a3f', fontWeight: 700, paddingLeft: 4 }}
                          >
                            🚚 {carrierOf(o.tracking)} · เช็กสถานะ ↗
                          </a>
                        )}
                        <div className="row-links">
                          <button type="button" className="hist-link" onClick={() => setHistoryOf(historyFor(o))} title="ดูประวัติการสั่ง (นับจากเบอร์)">👤 ประวัติ</button>
                          <button type="button" className="hist-link" onClick={() => openEditLog(o)} title="ใครแก้อะไร เมื่อไหร่">📝 การแก้</button>
                        </div>
                        {warns.length > 0 && (
                          <div className="warn-tags">
                            {warns.map((w) => (
                              <span key={w} className="warn-tag">⚠️ {w}</span>
                            ))}
                          </div>
                        )}
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
                      <td className="c-name">
                        <input className="cell-input" value={o.name || ''} placeholder="—"
                          onChange={(e) => updateField(o.id, 'name', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'name', e.target.value)} onBlur={(e) => cellBlur(o.id, 'name', e.target.value)} />
                      </td>
                      <td className="addr">
                        <textarea className="cell-input cell-addr" value={o.addr || ''} placeholder="—" rows={2}
                          onChange={(e) => updateField(o.id, 'addr', e.target.value)}
                          onFocus={(e) => cellFocus(o.id, 'addr', e.target.value)} onBlur={(e) => cellBlur(o.id, 'addr', e.target.value)} />
                      </td>
                      <td className="c-phone">
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
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td></td>
                    <td>{isRound ? 'รวมรอบนี้' : 'รวม'}</td>
                    <td className="qty">{total.toLocaleString()}</td>
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
              <img src={LOGO} alt="Snail Shop" style={{ height: 14, display: 'block' }} />
              <span>{o.date || '-'}</span>
            </div>
            <div className="lbl-acc">แอคเค้าตต: {o.tiktok || '-'}</div>
            <div className="lbl-row"><b>{o.name || '-'}</b> · {o.phone || '-'}</div>
            <div className="lbl-row">จำนวน {o.qty} ชุด{o.note && o.note !== '-' ? ` · ${o.note}` : ''}</div>
            {o.tracking && <div className="lbl-row">พัสดุ{carrierOf(o.tracking) ? ` (${carrierOf(o.tracking)})` : ''}: {o.tracking}</div>}
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
      {/* ===== POPUP รหัสเจ้าของ ก่อนล้างรอบ ===== */}
      {ownerModal && (
        <div className="modal-bg no-print" onClick={() => !ownerBusy && setOwnerModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">🔒 ล้างรอบส่ง {ownerModal.label}</div>
            <p style={{ fontSize: 14, marginBottom: 12 }}>
              จะลบออเดอร์ <b>{ownerModal.ids.length} รายการ</b> (กู้คืนได้จาก ♻️ ถังขยะ)
              <br />ต้องใส่<b>รหัสผ่านของเจ้าของ</b>ก่อนนะคะ
            </p>
            <input
              type="password"
              value={ownerPw}
              onChange={(e) => { setOwnerPw(e.target.value); setOwnerMsg('') }}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmClearRound() }}
              placeholder="รหัสผ่านเจ้าของ"
              autoComplete="off"
              autoFocus
              style={{ marginBottom: 10 }}
            />
            {ownerMsg && <p style={{ fontSize: 13, marginBottom: 10, color: 'var(--pink-deep)' }}>{ownerMsg}</p>}
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={confirmClearRound} disabled={ownerBusy}>
              {ownerBusy ? 'กำลังตรวจรหัส...' : `🗑️ ลบ ${ownerModal.ids.length} รายการ`}
            </button>
            <p className="mini-clear" style={{ marginTop: 12 }} onClick={() => !ownerBusy && setOwnerModal(null)}>ยกเลิก</p>
          </div>
        </div>
      )}
      {/* ===== POPUP ถังขยะ ===== */}
      {trash && (
        <div className="modal-bg no-print" onClick={() => !restoring && setTrash(null)}>
          <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">♻️ ถังขยะ — ออเดอร์ที่ถูกลบ</div>
            {trash.loading && <p>กำลังโหลด...</p>}
            {trash.err && <p style={{ color: 'var(--pink-deep)', fontSize: 14 }}>{trash.err}</p>}
            {!trash.loading && !trash.err && trash.groups.length === 0 && <p style={{ color: 'var(--muted)' }}>ถังขยะว่าง — ไม่มีออเดอร์ที่ถูกลบค่ะ</p>}
            {trash.groups.length > 0 && (() => {
              const allIds = trash.groups.flatMap((g) => g.rows.map((r) => r.id))
              return (
                <div className="trash-all">
                  <span>ทั้งหมด {allIds.length} ออเดอร์</span>
                  <button className="btn btn-primary btn-sm" style={{ width: 'auto' }} disabled={restoring} onClick={() => restoreLogs(allIds)}>♻️ กู้ทั้งหมด ({allIds.length})</button>
                  <button className="btn btn-danger btn-sm" disabled={restoring} onClick={() => purgeLogs(allIds)}>🔥 ลบถาวรทั้งหมด ({allIds.length})</button>
                </div>
              )
            })()}
            <div className="trash-list">
              {trash.groups.map((g) => (
                <div key={g.at + g.rows[0].id} className="trash-group">
                  <div className="trash-head">
                    <span>
                      {g.rows.length > 1 ? (
                        <b>ลบพร้อมกัน {g.rows.length} ออเดอร์{g.rows[0].send_date ? ` (รอบ ${g.rows[0].send_date})` : ''}</b>
                      ) : (
                        <b>ลบ 1 ออเดอร์</b>
                      )}
                      <span className="trash-meta"> · {fmtWhen(g.at)} · โดย {g.actor || 'ไม่ทราบ'}</span>
                    </span>
                    <span className="trash-btns">
                      <button className="btn btn-primary btn-sm" style={{ width: 'auto' }} disabled={restoring} onClick={() => restoreLogs(g.rows.map((r) => r.id))}>
                        {g.rows.length > 1 ? `กู้ทั้งกลุ่ม (${g.rows.length})` : 'กู้คืน'}
                      </button>
                      <button className="btn btn-danger btn-sm" disabled={restoring} onClick={() => purgeLogs(g.rows.map((r) => r.id))}>
                        {g.rows.length > 1 ? `ลบถาวรทั้งกลุ่ม` : 'ลบถาวร'}
                      </button>
                    </span>
                  </div>
                  {g.rows.map((r) => {
                    const b = r.before || {}
                    return (
                      <div key={r.id} className="trash-row">
                        <span>
                          {b.send_date || 'ฝาก'} · <b>{b.tiktok || '-'}</b> · {b.qty} ชุด{b.note && b.note !== '-' ? ` + ${b.note}` : ''} · {b.name || '-'}
                        </span>
                        {g.rows.length > 1 && (
                          <span className="trash-btns">
                            <button className="hist-link" disabled={restoring} onClick={() => restoreLogs([r.id])}>กู้อันนี้</button>
                            <button className="hist-link danger" disabled={restoring} onClick={() => purgeLogs([r.id])}>ลบถาวร</button>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            {trash.size && (
              <div className={'log-size' + (trash.size.db_bytes > 400 * 1024 * 1024 ? ' danger' : '')}>
                สมุดบันทึกใช้ {fmtMB(trash.size.log_bytes)} ({Number(trash.size.rows).toLocaleString()} บรรทัด) · ฐานข้อมูลรวม {fmtMB(trash.size.db_bytes)} / 500 MB
                {trash.size.db_bytes > 400 * 1024 * 1024 && ' ⚠️ ใกล้เต็มแล้ว'}
              </div>
            )}
            <p className="mini-clear" style={{ marginTop: 12 }} onClick={() => !restoring && setTrash(null)}>ปิด</p>
          </div>
        </div>
      )}
      {/* ===== POPUP ประวัติการแก้ ===== */}
      {editLog && (
        <div className="modal-bg no-print" onClick={() => setEditLog(null)}>
          <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">📝 การแก้ไข — {editLog.who}</div>
            {editLog.loading && <p>กำลังโหลด...</p>}
            {editLog.err && <p style={{ color: 'var(--pink-deep)', fontSize: 14 }}>{editLog.err}</p>}
            {!editLog.loading && !editLog.err && editLog.rows.length === 0 && (
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>ยังไม่มีบันทึก — ระบบเริ่มจดตั้งแต่วันที่ติดตั้งสมุดบันทึก</p>
            )}
            <div className="trash-list">
              {editLog.rows.map((r) => (
                <div key={r.id} className="log-row">
                  <div className="trash-meta">
                    {fmtWhen(r.at)} · {r.actor_email || 'ไม่ทราบ'} · <b>{LOG_ACTION_LABELS[r.action] || r.action}</b>
                  </div>
                  {r.action === 'update' &&
                    Object.keys(r.after || {})
                      .filter((k) => LOG_FIELD_LABELS[k])
                      .map((k) => (
                        <div key={k} className="log-change">
                          {LOG_FIELD_LABELS[k]}: <span className="log-old">{String(r.before?.[k] ?? '—') || '—'}</span> → <span className="log-new">{String(r.after[k] ?? '—') || '—'}</span>
                        </div>
                      ))}
                </div>
              ))}
            </div>
            <p className="mini-clear" style={{ marginTop: 12 }} onClick={() => setEditLog(null)}>ปิด</p>
          </div>
        </div>
      )}
      {/* ===== POPUP ประวัติลูกค้า ===== */}
      {historyOf && (
        <div className="modal-bg no-print" onClick={() => setHistoryOf(null)}>
          <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">👤 ประวัติลูกค้า</div>
            <div style={{ fontSize: 14, marginBottom: 4 }}>
              <b>{historyOf.who}</b> {historyOf.phone ? `· ${historyOf.phone}` : ''}
            </div>
            {!historyOf.byPhone && (
              <div className="warn-tag" style={{ display: 'inline-block', marginBottom: 6 }}>⚠️ ออเดอร์นี้ไม่มีเบอร์ — นับจากแอค TikTok แทน</div>
            )}
            <div className="hist-sum">
              สั่ง <b>{historyOf.list.length}</b> ครั้ง · รวม <b>{historyOf.qty.toLocaleString()}</b> ชุด · ครั้งแรก {historyOf.first} · ล่าสุด {historyOf.last}
            </div>
            {historyOf.accounts.length > 1 && (
              <div className="hist-accs">ใช้ {historyOf.accounts.length} แอค: {historyOf.accounts.join(', ')}</div>
            )}
            <div className="table-scroll" style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table className="hist-table">
                <thead>
                  <tr><th>วันส่ง</th><th>แอค TikTok</th><th>จำนวน</th><th>หมายเหตุ</th><th>สถานะ</th><th>เลขพัสดุ</th></tr>
                </thead>
                <tbody>
                  {historyOf.list.map((x) => (
                    <tr key={x.id}>
                      <td>{x.date || 'ฝาก'}</td>
                      <td>{x.tiktok || '-'}</td>
                      <td className="qty">{x.qty}</td>
                      <td>{x.note || '-'}</td>
                      <td>{x.status || '-'}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{x.tracking || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mini-clear" style={{ marginTop: 12 }} onClick={() => setHistoryOf(null)}>ปิด</p>
          </div>
        </div>
      )}
      {/* ===== POPUP เปลี่ยนรหัสผ่าน ===== */}
      {pwModal && (
        <div
          onClick={() => setPwModal(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(60,20,40,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 18, padding: 24, width: '100%', maxWidth: 400, boxShadow: '0 20px 50px rgba(0,0,0,.25)', fontFamily: "'Sarabun',sans-serif" }}
          >
            <div style={{ fontFamily: "'Mitr',sans-serif", fontSize: 18, color: 'var(--pink-deep)', marginBottom: 14 }}>🔑 เปลี่ยนรหัสผ่าน</div>
            <input
              type="password"
              value={newPw}
              onChange={(e) => { setNewPw(e.target.value); setPwMsg({ msg: '', ok: true }) }}
              placeholder="รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)"
              autoComplete="new-password"
              autoFocus
              style={{ marginBottom: 10 }}
            />
            <input
              type="password"
              value={newPw2}
              onChange={(e) => { setNewPw2(e.target.value); setPwMsg({ msg: '', ok: true }) }}
              onKeyDown={(e) => { if (e.key === 'Enter') changePassword() }}
              placeholder="พิมพ์รหัสผ่านใหม่อีกครั้ง"
              autoComplete="new-password"
              style={{ marginBottom: 10 }}
            />
            {pwMsg.msg && (
              <p style={{ fontSize: 13, marginBottom: 10, color: pwMsg.ok ? 'var(--ok)' : 'var(--pink-deep)' }}>{pwMsg.msg}</p>
            )}
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={changePassword} disabled={pwSaving}>
              {pwSaving ? 'กำลังบันทึก...' : 'บันทึกรหัสใหม่'}
            </button>
            <p className="mini-clear" style={{ marginTop: 12 }} onClick={() => setPwModal(false)}>ปิด</p>
          </div>
        </div>
      )}
    </>
  )
}
