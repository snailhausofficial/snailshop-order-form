/* =====================================================================
   ตัวแยกข้อความบรีฟงานช่าง → ช่าง / กำหนดส่ง / รายการ (ลาย ไซส์ จำนวน ราคา) / บรีฟ
   รองรับแบบสั้นๆ เช่น
     "ตามรูป S 20 M 30 L 10 ราคา 45 ส่ง 30/10"
     "ลายหินอ่อน M 50 ชุด\nลายดอกไม้ 20M 10L\nชุดละ 59\nกำหนดส่ง 2/11"
   ===================================================================== */

const SIZE_RE = /(?:^|[^A-Za-z0-9])(S|M|L)(?![A-Za-z])\s*[:=x×*]?\s*(\d{1,4})|(\d{1,4})\s*(?:ชุด)?\s*(?:ไซส์|ไซซ์|size)?\s*(S|M|L)(?![A-Za-z])/gi
const PRICE_RE = /(?:ราคา|ชุดละ|@)\s*(\d{1,4}(?:\.\d{1,2})?)|(\d{1,4}(?:\.\d{1,2})?)\s*(?:บาท|บ\.|฿)/i
const DATE_RE = /(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/

const pad = (n) => String(n).padStart(2, '0')

// DD/MM (+ปี ถ้ามี) → YYYY-MM-DD · ไม่มีปี = ปีนี้ ถ้าวันนั้นผ่านไปเกิน 2 เดือนแล้ว ถือเป็นปีหน้า
export function dateFromDdmm(d, m, y, today = new Date()) {
  d = Number(d)
  m = Number(m)
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return ''
  let year
  if (y) {
    year = Number(y)
    if (year < 100) year += 2000
    if (year > 2400) year -= 543 // พ.ศ.
  } else {
    year = today.getFullYear()
    const cand = new Date(year, m - 1, d)
    if (today - cand > 60 * 864e5) year++
  }
  return `${year}-${pad(m)}-${pad(d)}`
}

// ตัดคำนำหน้าที่ไม่ใช่ชื่อลาย
function cleanDesign(s) {
  return (s || '')
    .replace(/ไซส์|ไซซ์|size|จำนวน|ชุด|ราคา.*$|ชุดละ.*$/gi, ' ')
    .replace(/^[\s\-–•*:.,]+|[\s\-–•*:.,]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[ั็-๎]/g, '')
    .replace(/[^ก-๎a-z0-9]/g, '')

// หาช่างจากข้อความ: เทียบกับ ชื่อจริง / ชื่อในใบ / ชื่อเฟส / รหัส · ได้คนเดียวที่คะแนนสูงสุดเท่านั้น (เสมอ = ไม่เดา)
export function findArtisan(text, artisans) {
  const t = norm(text)
  if (!t) return null
  let best = null
  let bestScore = 0
  let tie = false
  for (const a of artisans) {
    let score = 0
    const keys = [a.name, a.nickname, a.facebook].filter(Boolean)
    for (const k of keys) {
      const full = norm(k)
      if (full.length >= 3 && t.includes(full)) score = Math.max(score, 10 + full.length)
      for (const w of k.split(/\s+/)) {
        const nw = norm(w)
        if (nw.length >= 3 && t.includes(nw)) score = Math.max(score, 5 + nw.length)
      }
    }
    if (a.code && new RegExp(`(?:ช่าง|รหัส|#)\\s*0*${Number(a.code)}(?!\\d)`).test(text)) score = Math.max(score, 30)
    if (score > bestScore) {
      best = a
      bestScore = score
      tie = false
    } else if (score && score === bestScore) tie = true
  }
  return bestScore && !tie ? best : null
}

export function parseBrief(raw, artisans = [], today = new Date()) {
  const text = (raw || '').replace(/\r/g, '')
  const rawLines = text.split('\n').map((l) => l.trim())
  const out = { artisanId: null, dueDate: '', items: [], brief: '', price: null }

  // ช่าง
  const a = findArtisan(text, artisans)
  if (a) out.artisanId = a.id
  // ลบชื่อช่างออกจากบรรทัด (ไม่ให้ไปปนชื่อลาย/บรีฟ)
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keys = a ? [a.facebook, a.name, a.nickname, ...(a.name || '').split(/\s+/)].filter((k) => k && k.length >= 2) : []
  keys.sort((x, y) => y.length - x.length)
  const nameRe = keys.length ? new RegExp(`(?:ช่าง|คุณ|น้อง)?\\s*(?:${keys.map(esc).join('|')})`, 'gi') : null
  const stripName = (l) => (nameRe ? l.replace(nameRe, ' ').replace(/\s{2,}/g, ' ').trim() : l)
  const lines = rawLines.map(stripName)

  // ราคา (ใช้กับทุกแถวที่ไม่ได้ระบุ)
  const pm = text.match(PRICE_RE)
  if (pm) out.price = Number(pm[1] || pm[2])

  const used = new Set()
  let lastDesign = ''
  lines.forEach((line, idx) => {
    if (!line) return
    // กำหนดส่ง — ต้องมีคำว่า ส่ง/กำหนด/ภายใน/ก่อน/วันที่ หรือบรรทัดเป็นวันที่ล้วน
    const dm = line.match(DATE_RE)
    if (dm && !out.dueDate && (/ส่ง|กำหนด|ภายใน|ก่อน|วันที่|due/i.test(line) || line.replace(DATE_RE, '').trim() === '')) {
      out.dueDate = dateFromDdmm(dm[1], dm[2], dm[3], today)
      if (line.replace(DATE_RE, '').replace(/ส่ง(ของ)?|กำหนด(ส่ง)?|ภายใน|ก่อน|วันที่|[:：]/g, '').trim() === '') used.add(idx)
    }

    const found = []
    let m
    SIZE_RE.lastIndex = 0
    while ((m = SIZE_RE.exec(line))) {
      const size = (m[1] || m[4]).toUpperCase()
      const qty = Number(m[2] || m[3])
      if (qty > 0) found.push({ size, qty, at: m.index })
    }
    if (!found.length) return
    used.add(idx)

    // ชื่อลาย = ข้อความก่อนไซส์แรก · ถ้าไม่มี ใช้บรรทัดก่อนหน้า (ถ้าเป็นข้อความล้วน) · ไม่งั้น "ตามรูป"
    let design = cleanDesign(line.slice(0, found[0].at).replace(/\d+\s*$/, ''))
    if (!design && idx > 0) {
      const prev = lines[idx - 1]
      if (prev && !used.has(idx - 1) && !DATE_RE.test(prev) && !PRICE_RE.test(prev) && prev.length <= 40) {
        design = cleanDesign(prev)
        if (design) used.add(idx - 1)
      }
    }
    if (!design) design = lastDesign || 'ตามรูป'
    lastDesign = design

    const lp = line.match(PRICE_RE)
    const price = lp ? Number(lp[1] || lp[2]) : out.price
    for (const f of found) out.items.push({ design, size: f.size, qty: String(f.qty), price: price != null ? String(price) : '' })
  })

  // บรรทัดที่ไม่ได้ใช้ = บรีฟ (ตัดบรรทัดราคาล้วนออก)
  out.brief = lines
    .filter((l, i) => l && !used.has(i) && !/^(?:ราคา|ชุดละ)\s*\d/.test(l))
    .join('\n')
    .trim()
  return out
}
