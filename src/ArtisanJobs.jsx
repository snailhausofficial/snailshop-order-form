import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, genOrderCode } from './supabase'
import { carrierOf, trackUrlOf } from './SnailOrderForm.jsx'
import NavSwitch from './NavSwitch.jsx'
import './jobs.css'

/* =====================================================================
   หลังร้าน: ระบบติดตามงานช่าง (/jobs)
   ข้อมูลอยู่คนละตารางกับออเดอร์ลูกค้า (artisans, artisan_jobs, job_*)
   ===================================================================== */

export const JOB_STATUSES = ['สั่งงาน', 'กำลังทำ', 'ช่างส่งของแล้ว', 'รับ/ตรวจแล้ว', 'จ่ายเงินแล้ว']
export const SIZES = ['S', 'M', 'L']
export const JOB_BUCKET = 'job-files'
const PAY_KINDS = ['มัดจำ', 'ปิดยอด', 'อื่นๆ']
const LOGO = '/logo.png'
const SITE_URL = import.meta.env.VITE_SITE_URL || 'https://order.snailshop.org'
const JOB_SELECT = '*, job_items(*), job_payments(*), job_delays(*), job_files(*)'

/* ---------- ตัวช่วยวันที่ / เงิน ---------- */
const pad = (n) => String(n).padStart(2, '0')
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const todayIso = () => isoOf(new Date())
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  return isoOf(new Date(y, m - 1, d + n))
}
export const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '-')
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
export const baht = (n) => r2(n).toLocaleString('th-TH', { maximumFractionDigits: 2 })
export const statusIdx = (s) => Math.max(0, JOB_STATUSES.indexOf(s))

/* ---------- ยอดรวมของใบงาน ---------- */
export function jobTotals(job) {
  const items = job.job_items || []
  const qty = items.reduce((s, i) => s + (Number(i.qty) || 0), 0)
  const amount = r2(items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0))
  const anyRecv = items.some((i) => i.qty_received != null)
  const recvQty = items.reduce((s, i) => s + (Number(i.qty_received) || 0), 0)
  const damaged = items.reduce((s, i) => s + (Number(i.qty_damaged) || 0), 0)
  const goodAmount = r2(
    items.reduce((s, i) => s + Math.max(0, (Number(i.qty_received) || 0) - (Number(i.qty_damaged) || 0)) * (Number(i.price) || 0), 0)
  )
  const paid = r2((job.job_payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0))
  const designs = new Set(items.map((i) => (i.design || '').trim()).filter(Boolean)).size
  return { qty, amount, anyRecv, recvQty, damaged, goodAmount, paid, balance: r2(amount - paid), designs }
}

/* ---------- รูป: ย่อให้เล็กก่อนอัป (ประหยัดเน็ต + พื้นที่) ---------- */
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type || '')) return file
  try {
    const bmp = await createImageBitmap(file)
    const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const heic = /hei[cf]/.test(file.type)
    if (sc === 1 && file.size < 1.5e6 && !heic) return file
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * sc)
    c.height = Math.round(bmp.height * sc)
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85))
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file
  } catch {
    return file
  }
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

// อัปไฟล์ไว้ใต้โฟลเดอร์เลขงาน ชื่อไฟล์สุ่ม → คืน path
export async function uploadJobFile(code, file) {
  const f = await shrinkImage(file)
  const type = f.type || 'image/jpeg'
  const ext = type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : /hei[cf]/.test(type) ? 'heic' : 'jpg'
  const path = `${code}/${randomId()}.${ext}`
  const { error } = await supabase.storage.from(JOB_BUCKET).upload(path, f, { contentType: type, upsert: false })
  if (error) throw error
  return path
}
export const fileUrl = (path) => (path && supabase ? supabase.storage.from(JOB_BUCKET).getPublicUrl(path).data.publicUrl : '')
const isPdf = (path) => /\.pdf$/i.test(path || '')

/* ---------- ป้ายเตือนบนใบงาน ---------- */
function jobFlags(job, artisan) {
  const f = []
  const si = statusIdx(job.status)
  const t = jobTotals(job)
  const today = todayIso()
  if (artisan && !artisan.id_card_ok) f.push({ t: 'ยังไม่มีบัตร ปชช.', c: 'rd' })
  if (si < 2 && job.due_date && job.due_date < today) f.push({ t: '⏰ เลยกำหนด ' + ddmm(job.due_date), c: 'rd' })
  else if (si < 2 && !job.tracking && job.due_date && job.due_date <= addDays(today, 1)) f.push({ t: '⏰ ใกล้กำหนด · ยังไม่ส่งเลข', c: 'am' })
  if (job.tracking) f.push({ t: '🚚 ' + (carrierOf(job.tracking) || 'มีเลขพัสดุแล้ว'), c: 'tl' })
  const nd = (job.job_delays || []).length
  if (nd) f.push({ t: `🔁 เลื่อน ${nd} ครั้ง`, c: 'am' })
  if (si >= 3 && t.balance > 0) f.push({ t: `ค้างจ่าย ${baht(t.balance)} ฿`, c: 'rd' })
  else if (t.paid > 0 && t.balance > 0) f.push({ t: `จ่ายแล้ว ${baht(t.paid)} ฿`, c: 'gr' })
  else if (t.amount > 0 && t.balance <= 0) f.push({ t: 'จ่ายครบ', c: 'gr' })
  return f
}
const Tags = ({ list }) => list.map((x, i) => <span key={i} className={'tag ' + x.c}>{x.t}</span>)

const emptyItem = (size = 'S') => ({ design: '', size, qty: '', price: '', qty_received: '', qty_damaged: '' })
const numOrNull = (v) => (v === '' || v == null ? null : Math.max(0, Number(v) || 0))

/* =====================================================================
   หน้าหลัก
   ===================================================================== */
export default function ArtisanJobs() {
  const navigate = useNavigate()
  const [auth, setAuth] = useState('checking') // checking | in | out | none
  const [artisans, setArtisans] = useState([])
  const [jobs, setJobs] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState({ name: 'list' }) // list | new | job | artisans
  const [filter, setFilter] = useState('open')
  const [q, setQ] = useState('')
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)

  useEffect(() => {
    document.title = 'SnailShop — งานช่าง'
  }, [])

  useEffect(() => {
    if (!supabase) {
      setAuth('none')
      return
    }
    supabase.auth.getSession().then(({ data }) => setAuth(data.session ? 'in' : 'out'))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setAuth(s ? 'in' : 'out'))
    return () => sub.subscription.unsubscribe()
  }, [])

  function say(msg, ok = true) {
    setToast({ msg, ok })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), ok ? 3500 : 8000)
  }

  async function loadAll() {
    const [a, j] = await Promise.all([
      supabase.from('artisans').select('*').order('name'),
      supabase.from('artisan_jobs').select(JOB_SELECT).order('created_at', { ascending: false }),
    ])
    if (a.error || j.error) {
      const msg = (a.error || j.error).message
      say('โหลดข้อมูลไม่ได้: ' + msg + (/does not exist|schema cache/.test(msg) ? ' — ยังไม่ได้รัน SQL ขั้น 1 หรือเปล่าคะ' : ''), false)
      setLoaded(true)
      return
    }
    setArtisans(a.data || [])
    setJobs(j.data || [])
    setLoaded(true)
  }

  useEffect(() => {
    if (auth === 'in') loadAll()
  }, [auth])

  // โหลดใบงานเดียวใหม่หลังแก้ไข
  async function refreshJob(id) {
    const { data, error } = await supabase.from('artisan_jobs').select(JOB_SELECT).eq('id', id).single()
    if (error) {
      say('โหลดใบงานใหม่ไม่ได้: ' + error.message, false)
      return
    }
    setJobs((prev) => (prev.some((x) => x.id === id) ? prev.map((x) => (x.id === id ? data : x)) : [data, ...prev]))
  }

  async function refreshArtisans() {
    const { data } = await supabase.from('artisans').select('*').order('name')
    if (data) setArtisans(data)
  }

  async function logout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  const artById = useMemo(() => Object.fromEntries(artisans.map((a) => [a.id, a])), [artisans])

  /* ---------- หน้าล็อก ---------- */
  if (auth === 'checking') {
    return (
      <div className="lock-wrap">
        <div className="lock-card"><p>กำลังโหลด...</p></div>
      </div>
    )
  }
  if (auth === 'none') {
    return (
      <div className="lock-wrap">
        <div className="lock-card">
          <img src={LOGO} alt="Snail Shop" style={{ width: '100%', maxWidth: 200, display: 'block', margin: '0 auto 10px' }} />
          <p>ระบบงานช่างต้องต่อฐานข้อมูล (ตั้งค่า .env.local / Vercel) ก่อนใช้งาน</p>
          <Link to="/" className="btn btn-ghost">กลับหน้าออเดอร์</Link>
        </div>
      </div>
    )
  }
  if (auth === 'out') {
    return (
      <div className="lock-wrap">
        <div className="lock-card">
          <img src={LOGO} alt="Snail Shop" style={{ width: '100%', maxWidth: 200, display: 'block', margin: '0 auto 10px' }} />
          <p>สำหรับพนักงานเท่านั้น — ล็อกอินที่หน้าออเดอร์ก่อนนะคะ</p>
          <Link to="/" className="btn btn-primary">ไปหน้าล็อกอิน</Link>
        </div>
      </div>
    )
  }

  const current = view.name === 'job' ? jobs.find((j) => j.id === view.id) : null

  return (
    <>
      <header>
        <img src={LOGO} alt="Snail Shop" style={{ height: 44, background: '#fff', borderRadius: 12, padding: '4px 10px', display: 'block' }} />
        <div>
          <p>ติดตามงานช่าง</p>
        </div>
        <span className="conn on">● บันทึกลงฐานข้อมูล</span>
        <button className="logout-btn no-print" onClick={logout} title="ออกจากระบบ">ออก</button>
      </header>
      <NavSwitch active="jobs" />

      <div className="jb-wrap">
        {toast && <div className={'jb-toast' + (toast.ok ? '' : ' err')} onClick={() => setToast(null)}>{toast.msg}</div>}

        {!loaded && <p className="jb-muted">กำลังโหลด...</p>}

        {loaded && view.name === 'list' && (
          <JobList
            jobs={jobs}
            artById={artById}
            artisans={artisans}
            filter={filter}
            setFilter={setFilter}
            q={q}
            setQ={setQ}
            onOpen={(id) => setView({ name: 'job', id })}
            onNew={() => setView({ name: 'new' })}
            onArtisans={() => setView({ name: 'artisans' })}
          />
        )}

        {loaded && view.name === 'new' && (
          <NewJob
            artisans={artisans}
            say={say}
            onCancel={() => setView({ name: 'list' })}
            onCreated={async (id) => {
              await refreshArtisans()
              await refreshJob(id)
              setView({ name: 'job', id })
            }}
          />
        )}

        {loaded && view.name === 'job' && current && (
          <JobDetail
            key={current.id}
            job={current}
            artisan={artById[current.artisan_id]}
            say={say}
            refresh={() => refreshJob(current.id)}
            onBack={() => setView({ name: 'list' })}
            onDeleted={() => {
              setJobs((prev) => prev.filter((x) => x.id !== current.id))
              setView({ name: 'list' })
            }}
          />
        )}
        {loaded && view.name === 'job' && !current && (
          <div className="jb-card">
            <p>ไม่พบใบงานนี้</p>
            <button className="btn btn-ghost btn-sm" onClick={() => setView({ name: 'list' })}>← กลับ</button>
          </div>
        )}

        {loaded && view.name === 'artisans' && (
          <ArtisanList
            artisans={artisans}
            jobs={jobs}
            say={say}
            refresh={refreshArtisans}
            onBack={() => setView({ name: 'list' })}
          />
        )}
      </div>
    </>
  )
}

/* =====================================================================
   รายการใบงาน
   ===================================================================== */
const FILTERS = [
  ['open', 'ยังไม่จบ'],
  ['late', 'เลยกำหนด'],
  ['topay', 'รอจ่าย'],
  ['done', 'จ่ายเงินแล้ว'],
  ['all', 'ทั้งหมด'],
]

function JobList({ jobs, artById, artisans, filter, setFilter, q, setQ, onOpen, onNew, onArtisans }) {
  const today = todayIso()
  const test = {
    open: (j) => j.status !== 'จ่ายเงินแล้ว',
    late: (j) => statusIdx(j.status) < 2 && j.due_date && j.due_date < today,
    topay: (j) => statusIdx(j.status) >= 2 && j.status !== 'จ่ายเงินแล้ว' && jobTotals(j).balance > 0,
    done: (j) => j.status === 'จ่ายเงินแล้ว',
    all: () => true,
  }
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, jobs.filter(test[k]).length]))
  const needle = q.trim().toLowerCase()
  const shown = jobs
    .filter(test[filter])
    .filter((j) => {
      if (!needle) return true
      const a = artById[j.artisan_id]
      const hay = [a?.name, j.code, j.brief, ...(j.job_items || []).map((i) => i.design)].join(' ').toLowerCase()
      return hay.includes(needle)
    })
    .sort((x, y) => {
      // งานยังไม่จบขึ้นก่อน แล้วเรียงตามกำหนดส่งใกล้สุด
      const dx = x.status === 'จ่ายเงินแล้ว' ? 1 : 0
      const dy = y.status === 'จ่ายเงินแล้ว' ? 1 : 0
      if (dx !== dy) return dx - dy
      return (x.due_date || '9999').localeCompare(y.due_date || '9999')
    })

  return (
    <>
      <div className="jb-row" style={{ marginBottom: 4 }}>
        <button className="btn btn-rose" style={{ flex: 1 }} onClick={onNew}>➕ สร้างใบงานใหม่</button>
        <button className="btn btn-ghost" onClick={onArtisans}>👩‍🎨 รายชื่อช่าง ({artisans.length})</button>
      </div>

      <div className="jb-chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={'jb-chip' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>
            {label} {counts[k]}
          </button>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหา ชื่อช่าง / ลาย / เลขงาน" style={{ marginBottom: 12 }} />

      {shown.length === 0 && (
        <div className="jb-card" style={{ textAlign: 'center' }}>
          <p className="jb-muted">{jobs.length ? 'ไม่มีใบงานในตัวกรองนี้' : 'ยังไม่มีใบงาน — กด "สร้างใบงานใหม่" เพื่อเริ่ม'}</p>
        </div>
      )}

      {shown.map((j) => {
        const a = artById[j.artisan_id]
        const t = jobTotals(j)
        return (
          <button key={j.id} className="jb-job" onClick={() => onOpen(j.id)}>
            <div className="jb-job-top">
              <span className="jb-name">{a?.name || '(ไม่พบช่าง)'}</span>
              <span className="tag pk" style={{ marginTop: 2 }}>{j.status}</span>
            </div>
            <div className="jb-muted">
              {t.designs} ลาย · {t.qty} ชุด · {baht(t.amount)} ฿ · ส่ง {ddmm(j.due_date)}
            </div>
            <Tags list={jobFlags(j, a)} />
          </button>
        )
      })}
    </>
  )
}

/* =====================================================================
   ตารางแก้รายการ (ลาย / ไซส์ / จำนวน / ราคา / รับจริง / ชำรุด)
   ===================================================================== */
function ItemsEditor({ rows, setRows, showReceive }) {
  const upd = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  const del = (i) => setRows(rows.filter((_, j) => j !== i))
  // คัดลอกแถว → ลายเดิม ไซส์ถัดไป (กรอกลายเดียวหลายไซส์ได้เร็ว)
  const dup = (i) => {
    const r = rows[i]
    const next = SIZES[(SIZES.indexOf(r.size) + 1) % SIZES.length]
    const copy = { ...r, size: next, qty: '', qty_received: '', qty_damaged: '' }
    setRows([...rows.slice(0, i + 1), copy, ...rows.slice(i + 1)])
  }
  const total = r2(rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0))
  const qty = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0)

  return (
    <>
      <div className="jb-scroll">
        <table className="jb-table">
          <thead>
            <tr>
              <th>ลาย</th>
              <th>ไซส์</th>
              <th>จำนวน</th>
              <th>ราคา/ชุด</th>
              {showReceive && <th>รับจริง</th>}
              {showReceive && <th>ชำรุด</th>}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ minWidth: 120 }}>
                  <input value={r.design} onChange={(e) => upd(i, 'design', e.target.value)} placeholder="ชื่อลาย" />
                </td>
                <td style={{ width: 72 }}>
                  <select value={r.size} onChange={(e) => upd(i, 'size', e.target.value)} style={{ minWidth: 60, padding: '6px 4px' }}>
                    {SIZES.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </td>
                <td style={{ width: 70 }}>
                  <input inputMode="numeric" value={r.qty} onChange={(e) => upd(i, 'qty', e.target.value.replace(/\D/g, ''))} placeholder="0" />
                </td>
                <td style={{ width: 80 }}>
                  <input inputMode="decimal" value={r.price} onChange={(e) => upd(i, 'price', e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" />
                </td>
                {showReceive && (
                  <td style={{ width: 70 }}>
                    <input inputMode="numeric" value={r.qty_received ?? ''} onChange={(e) => upd(i, 'qty_received', e.target.value.replace(/\D/g, ''))} placeholder="-" />
                  </td>
                )}
                {showReceive && (
                  <td style={{ width: 70 }}>
                    <input inputMode="numeric" value={r.qty_damaged ?? ''} onChange={(e) => upd(i, 'qty_damaged', e.target.value.replace(/\D/g, ''))} placeholder="-" />
                  </td>
                )}
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="icon-btn" title="คัดลอกเป็นไซส์ถัดไป" onClick={() => dup(i)}>⧉</button>
                  <button className="icon-btn" title="ลบแถว" onClick={() => del(i)}>🗑</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="jb-row" style={{ marginTop: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, emptyItem(rows.length ? rows[rows.length - 1].size : 'S')])}>➕ เพิ่มแถว</button>
        <span className="jb-small">⧉ = คัดลอกลายเดิมเป็นไซส์ถัดไป</span>
      </div>
      <div className="jb-total"><span>รวม {qty} ชุด</span><span>{baht(total)} ฿</span></div>
    </>
  )
}

function cleanItems(rows, jobId) {
  return rows
    .filter((r) => (r.design || '').trim() || Number(r.qty) > 0)
    .map((r, i) => ({
      job_id: jobId,
      sort: i,
      design: (r.design || '').trim(),
      size: SIZES.includes(r.size) ? r.size : 'M',
      qty: Math.max(0, Number(r.qty) || 0),
      price: r2(r.price),
      qty_received: numOrNull(r.qty_received),
      qty_damaged: numOrNull(r.qty_damaged),
    }))
}

/* =====================================================================
   สร้างใบงานใหม่
   ===================================================================== */
function NewJob({ artisans, say, onCancel, onCreated }) {
  const active = artisans.filter((a) => a.active)
  const [artisanId, setArtisanId] = useState(active[0]?.id ? String(active[0].id) : 'new')
  const [newName, setNewName] = useState('')
  const [orderDate, setOrderDate] = useState(todayIso())
  const [dueDate, setDueDate] = useState(addDays(todayIso(), 7))
  const [brief, setBrief] = useState('')
  const [note, setNote] = useState('')
  const [rows, setRows] = useState([emptyItem('S')])
  const [saving, setSaving] = useState(false)

  async function save() {
    const items = cleanItems(rows, 0)
    if (artisanId === 'new' && !newName.trim()) return say('ใส่ชื่อช่างก่อนนะคะ', false)
    if (!items.length) return say('ใส่รายการอย่างน้อย 1 แถว', false)
    if (items.some((i) => !i.design)) return say('มีแถวที่ยังไม่ใส่ชื่อลาย', false)
    setSaving(true)
    try {
      let aid = Number(artisanId)
      if (artisanId === 'new') {
        const { data, error } = await supabase.from('artisans').insert({ name: newName.trim() }).select().single()
        if (error) throw error
        aid = data.id
      }
      const { data: job, error } = await supabase
        .from('artisan_jobs')
        .insert({ code: genOrderCode(), artisan_id: aid, order_date: orderDate || todayIso(), due_date: dueDate || null, brief: brief.trim(), internal_note: note.trim() })
        .select()
        .single()
      if (error) throw error
      const { error: e2 } = await supabase.from('job_items').insert(cleanItems(rows, job.id))
      if (e2) throw e2
      say('✅ สร้างใบงานแล้ว')
      await onCreated(job.id)
    } catch (e) {
      say('บันทึกไม่สำเร็จ: ' + e.message, false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="jb-card">
      <h3>
        <span>➕ ใบงานใหม่</span>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>ยกเลิก</button>
      </h3>

      <div className="jb-field">
        <label>ช่าง</label>
        <select value={artisanId} onChange={(e) => setArtisanId(e.target.value)}>
          {active.map((a) => (
            <option key={a.id} value={a.id}>{a.name}{a.id_card_ok ? '' : ' (ยังไม่มีบัตร ปชช.)'}</option>
          ))}
          <option value="new">➕ ช่างใหม่...</option>
        </select>
        {artisanId === 'new' && (
          <input style={{ marginTop: 8 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ชื่อช่างใหม่" autoFocus />
        )}
      </div>

      <div className="jb-2col">
        <div className="jb-field">
          <label>วันสั่งงาน</label>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div className="jb-field">
          <label>กำหนดส่ง</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>

      <div className="jb-field">
        <label>บรีฟงาน (ช่างเห็น)</label>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="รายละเอียด สี ทรง ความยาว แพ็กแบบไหน ฯลฯ" />
      </div>

      <label>รายการ</label>
      <ItemsEditor rows={rows} setRows={setRows} />

      <div className="jb-field" style={{ marginTop: 12 }}>
        <label>โน้ตภายใน (ช่างไม่เห็น)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="ไม่บังคับ" style={{ minHeight: 56 }} />
      </div>

      <button className="btn btn-rose" style={{ width: '100%' }} onClick={save} disabled={saving}>
        {saving ? 'กำลังบันทึก...' : '💾 บันทึกใบงาน'}
      </button>
      <p className="jb-small" style={{ marginTop: 8, textAlign: 'center' }}>บันทึกแล้วแนบรูปบรีฟ / สลิปมัดจำ ได้ในหน้าใบงาน</p>
    </div>
  )
}

/* =====================================================================
   หน้าใบงาน
   ===================================================================== */
function JobDetail({ job, artisan, say, refresh, onBack, onDeleted }) {
  const t = jobTotals(job)
  const items = [...(job.job_items || [])].sort((a, b) => a.sort - b.sort || a.id - b.id)
  const delays = [...(job.job_delays || [])].sort((a, b) => a.seq - b.seq)
  const payments = [...(job.job_payments || [])].sort((a, b) => (a.paid_on || '').localeCompare(b.paid_on || '') || a.id - b.id)
  const files = [...(job.job_files || [])].sort((a, b) => a.id - b.id)

  const [editItems, setEditItems] = useState(false)
  const [rows, setRows] = useState([])
  const [editBrief, setEditBrief] = useState(false)
  const [brief, setBrief] = useState(job.brief)
  const [note, setNote] = useState(job.internal_note)
  const [tracking, setTracking] = useState(job.tracking)
  const [busy, setBusy] = useState('')
  // ฟอร์มจ่ายเงิน
  const [payKind, setPayKind] = useState(t.paid > 0 ? 'ปิดยอด' : 'มัดจำ')
  const [payAmt, setPayAmt] = useState('')
  const [payDate, setPayDate] = useState(todayIso())
  const [payFile, setPayFile] = useState(null)
  // ฟอร์มเลื่อน
  const [showDelay, setShowDelay] = useState(false)
  const [delayDate, setDelayDate] = useState(job.due_date ? addDays(job.due_date, 3) : addDays(todayIso(), 3))
  const [delayReason, setDelayReason] = useState('')
  // อัปรูป
  const [fileKind, setFileKind] = useState('รูปงาน')

  useEffect(() => {
    setTracking(job.tracking)
  }, [job.tracking])

  async function run(label, fn, okMsg) {
    setBusy(label)
    try {
      await fn()
      await refresh()
      if (okMsg) say(okMsg)
    } catch (e) {
      say('ไม่สำเร็จ: ' + (e.message || e), false)
    } finally {
      setBusy('')
    }
  }
  const must = ({ error }) => {
    if (error) throw error
  }

  const updateJob = (patch) => supabase.from('artisan_jobs').update(patch).eq('id', job.id).then(must)

  async function copyLink() {
    const link = `${SITE_URL}/job/${job.code}`
    try {
      await navigator.clipboard.writeText(link)
      say('📋 คัดลอกลิงก์แล้ว — หน้าช่างจะเปิดได้หลังทำขั้น 2')
    } catch {
      window.prompt('คัดลอกลิงก์นี้', link)
    }
  }

  function startEditItems() {
    setRows(
      items.map((i) => ({
        design: i.design,
        size: i.size,
        qty: String(i.qty ?? ''),
        price: String(i.price ?? ''),
        qty_received: i.qty_received == null ? '' : String(i.qty_received),
        qty_damaged: i.qty_damaged == null ? '' : String(i.qty_damaged),
      }))
    )
    setEditItems(true)
  }

  function saveItems() {
    const clean = cleanItems(rows, job.id)
    if (!clean.length) return say('ต้องมีอย่างน้อย 1 แถว', false)
    if (clean.some((i) => !i.design)) return say('มีแถวที่ยังไม่ใส่ชื่อลาย', false)
    if (!window.confirm('บันทึกรายการที่แก้ใช่ไหมคะ?')) return
    run(
      'items',
      async () => {
        await supabase.from('job_items').delete().eq('job_id', job.id).then(must)
        await supabase.from('job_items').insert(clean).then(must)
        setEditItems(false)
      },
      '✅ บันทึกรายการแล้ว'
    )
  }

  function saveTracking() {
    const tk = tracking.replace(/\s/g, '').toUpperCase()
    const patch = { tracking: tk, tracking_at: tk ? new Date().toISOString() : null }
    if (tk && statusIdx(job.status) < 2) patch.status = 'ช่างส่งของแล้ว'
    run('track', () => updateJob(patch), tk ? '✅ บันทึกเลขพัสดุแล้ว' : 'ลบเลขพัสดุแล้ว')
  }

  function addPayment() {
    const amt = r2(payAmt)
    if (!(amt > 0)) return say('ใส่จำนวนเงินก่อนนะคะ', false)
    run(
      'pay',
      async () => {
        let slip = ''
        if (payFile) slip = await uploadJobFile(job.code, payFile)
        await supabase.from('job_payments').insert({ job_id: job.id, kind: payKind, amount: amt, paid_on: payDate || todayIso(), slip_path: slip }).then(must)
        // จ่ายครบ + รับของแล้ว → ปิดงานเป็น "จ่ายเงินแล้ว"
        if (r2(t.paid + amt) >= t.amount && t.amount > 0 && statusIdx(job.status) >= 3) await updateJob({ status: 'จ่ายเงินแล้ว' })
        setPayAmt('')
        setPayFile(null)
        setPayKind('ปิดยอด')
      },
      '✅ บันทึกการจ่ายเงินแล้ว'
    )
  }

  function delPayment(p) {
    if (!window.confirm(`ลบรายการจ่าย ${p.kind} ${baht(p.amount)} ฿ (${ddmm(p.paid_on)}) ใช่ไหม?`)) return
    run('pay', async () => {
      await supabase.from('job_payments').delete().eq('id', p.id).then(must)
      if (p.slip_path) await supabase.storage.from(JOB_BUCKET).remove([p.slip_path])
    }, 'ลบแล้ว')
  }

  function addDelay() {
    if (!delayDate) return say('เลือกวันใหม่ก่อนนะคะ', false)
    run(
      'delay',
      async () => {
        await supabase
          .from('job_delays')
          .insert({ job_id: job.id, seq: delays.length + 1, old_date: job.due_date, new_date: delayDate, reason: delayReason.trim() })
          .then(must)
        await updateJob({ due_date: delayDate })
        setShowDelay(false)
        setDelayReason('')
      },
      `✅ บันทึกเลื่อนครั้งที่ ${delays.length + 1} แล้ว`
    )
  }

  function delDelay(d) {
    if (!window.confirm(`ลบประวัติเลื่อนครั้งที่ ${d.seq} ใช่ไหม? (กำหนดส่งปัจจุบันไม่เปลี่ยน)`)) return
    run('delay', () => supabase.from('job_delays').delete().eq('id', d.id).then(must), 'ลบแล้ว')
  }

  async function onUpload(e) {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    if (!list.length) return
    run(
      'file',
      async () => {
        for (const f of list) {
          const path = await uploadJobFile(job.code, f)
          await supabase.from('job_files').insert({ job_id: job.id, path, kind: fileKind, uploaded_by: 'ร้าน' }).then(must)
        }
      },
      `✅ อัป ${list.length} ไฟล์แล้ว`
    )
  }

  function delFile(f) {
    if (!window.confirm('ลบรูปนี้ใช่ไหม?')) return
    run('file', async () => {
      await supabase.from('job_files').delete().eq('id', f.id).then(must)
      await supabase.storage.from(JOB_BUCKET).remove([f.path])
    }, 'ลบรูปแล้ว')
  }

  function deleteJob() {
    const name = artisan?.name || ''
    if (!window.confirm(`ลบใบงานของ ${name} (${t.qty} ชุด) ทั้งใบ รวมประวัติจ่ายเงิน/เลื่อน/รูป ใช่ไหม?\nลบแล้วกู้คืนไม่ได้`)) return
    setBusy('del')
    ;(async () => {
      try {
        const paths = [...files.map((f) => f.path), ...payments.map((p) => p.slip_path)].filter(Boolean)
        await supabase.from('artisan_jobs').delete().eq('id', job.id).then(must)
        if (paths.length) await supabase.storage.from(JOB_BUCKET).remove(paths)
        say('ลบใบงานแล้ว')
        onDeleted()
      } catch (e) {
        say('ลบไม่สำเร็จ: ' + e.message, false)
        setBusy('')
      }
    })()
  }

  const tkUrl = trackUrlOf(job.tracking)

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={onBack}>← รายการใบงาน</button>

      {/* ---------- หัวใบงาน ---------- */}
      <div className="jb-card">
        <div className="jb-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="jb-grow">
            <div className="jb-name" style={{ fontSize: 20 }}>{artisan?.name || '(ไม่พบช่าง)'}</div>
            <div className="jb-code">{job.code}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={copyLink}>🔗 ลิงก์ช่าง</button>
        </div>
        <Tags list={jobFlags(job, artisan)} />

        <div className="jb-2col" style={{ marginTop: 12 }}>
          <div className="jb-field">
            <label>สถานะ</label>
            <select
              className="status-select"
              style={{ width: '100%', padding: '9px 10px' }}
              value={job.status}
              disabled={!!busy}
              onChange={(e) => run('status', () => updateJob({ status: e.target.value }), 'เปลี่ยนสถานะแล้ว')}
            >
              {JOB_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="jb-field">
            <label>วันสั่ง → กำหนดส่ง</label>
            <div style={{ padding: '9px 2px', fontSize: 15 }}>
              {ddmm(job.order_date)} → <b style={{ color: 'var(--pink-deep)', fontWeight: 400 }}>{ddmm(job.due_date)}</b>
              {delays.length > 0 && <span className="jb-small"> (เดิม {ddmm(delays[0].old_date)})</span>}
            </div>
          </div>
        </div>
      </div>

      {/* ---------- บรีฟ + รายการ ---------- */}
      <div className="jb-card">
        <h3>
          <span>📝 บรีฟงาน</span>
          {!editBrief ? (
            <button className="btn btn-ghost btn-sm" onClick={() => { setBrief(job.brief); setEditBrief(true) }}>แก้</button>
          ) : (
            <span className="jb-row">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditBrief(false)}>ยกเลิก</button>
              <button
                className="btn btn-rose btn-sm"
                disabled={!!busy}
                onClick={() => run('brief', async () => { await updateJob({ brief: brief.trim() }); setEditBrief(false) }, '✅ บันทึกบรีฟแล้ว')}
              >
                บันทึก
              </button>
            </span>
          )}
        </h3>
        {editBrief ? (
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} />
        ) : (
          <p style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{job.brief || <span className="jb-muted">— ไม่มี —</span>}</p>
        )}

        <h3 style={{ marginTop: 16 }}>
          <span>🎨 รายการ</span>
          {!editItems ? (
            <button className="btn btn-ghost btn-sm" onClick={startEditItems}>แก้ / กรอกรับของ</button>
          ) : (
            <span className="jb-row">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditItems(false)}>ยกเลิก</button>
              <button className="btn btn-rose btn-sm" disabled={!!busy} onClick={saveItems}>บันทึก</button>
            </span>
          )}
        </h3>

        {editItems ? (
          <ItemsEditor rows={rows} setRows={setRows} showReceive />
        ) : (
          <>
            <div className="jb-scroll">
              <table className="jb-table">
                <thead>
                  <tr>
                    <th>ลาย</th>
                    <th>ไซส์</th>
                    <th className="num">สั่ง</th>
                    <th className="num">ราคา</th>
                    <th className="num">รวม</th>
                    {t.anyRecv && <th className="num">รับ</th>}
                    {t.anyRecv && <th className="num">ชำรุด</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.design}</td>
                      <td>{i.size}</td>
                      <td className="num">{i.qty}</td>
                      <td className="num">{baht(i.price)}</td>
                      <td className="num">{baht(i.qty * i.price)}</td>
                      {t.anyRecv && <td className="num">{i.qty_received ?? '-'}</td>}
                      {t.anyRecv && <td className="num" style={{ color: i.qty_damaged ? '#B42318' : undefined }}>{i.qty_damaged ?? '-'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="jb-total"><span>รวม {t.qty} ชุด</span><span>{baht(t.amount)} ฿</span></div>
            {t.anyRecv && (
              <p className="jb-small" style={{ textAlign: 'right', marginTop: 4 }}>
                รับจริง {t.recvQty} · ชำรุด {t.damaged} · ของดีคิดเป็น {baht(t.goodAmount)} ฿
              </p>
            )}
          </>
        )}
      </div>

      {/* ---------- จ่ายเงิน ---------- */}
      <div className="jb-card">
        <h3><span>💸 จ่ายเงินช่าง</span></h3>
        {payments.length === 0 && <p className="jb-muted" style={{ marginBottom: 8 }}>ยังไม่มีการจ่าย</p>}
        {payments.map((p) => (
          <div key={p.id} className="jb-list-line">
            <span className="jb-grow">
              {p.kind} · {ddmm(p.paid_on)}{' '}
              {p.slip_path ? (
                <a className="jb-link" href={fileUrl(p.slip_path)} target="_blank" rel="noreferrer">🧾 สลิป</a>
              ) : (
                <span className="jb-small">(ไม่มีสลิป)</span>
              )}
            </span>
            <span>{baht(p.amount)} ฿</span>
            <button className="icon-btn" title="ลบ" onClick={() => delPayment(p)}>🗑</button>
          </div>
        ))}
        <div className="jb-kv" style={{ borderTop: '1px solid var(--line)', marginTop: 4, paddingTop: 8 }}>
          <span>ยอดใบงาน {baht(t.amount)} · จ่ายแล้ว {baht(t.paid)}</span>
          <b>คงเหลือ {baht(t.balance)} ฿</b>
        </div>

        <div style={{ background: 'var(--petal)', borderRadius: 12, padding: 12, marginTop: 10 }}>
          <div className="jb-2col">
            <div className="jb-field">
              <label>ประเภท</label>
              <select value={payKind} onChange={(e) => setPayKind(e.target.value)}>
                {PAY_KINDS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </div>
            <div className="jb-field">
              <label>จำนวนเงิน (บาท)</label>
              <input inputMode="decimal" value={payAmt} onChange={(e) => setPayAmt(e.target.value.replace(/[^\d.]/g, ''))} placeholder={t.balance > 0 ? String(t.balance) : '0'} />
            </div>
            <div className="jb-field">
              <label>วันที่โอน</label>
              <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </div>
            <div className="jb-field">
              <label>สลิป</label>
              <label className="btn btn-ghost btn-sm jb-upload" style={{ width: '100%', margin: 0 }}>
                {payFile ? '✓ ' + (payFile.name || 'เลือกแล้ว').slice(0, 18) : '📎 แนบสลิป'}
                <input type="file" accept="image/*,application/pdf" onChange={(e) => setPayFile(e.target.files?.[0] || null)} />
              </label>
            </div>
          </div>
          <div className="jb-row">
            {t.balance > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setPayAmt(String(t.balance)); setPayKind('ปิดยอด') }}>ใส่ยอดคงเหลือ</button>
            )}
            <button className="btn btn-rose btn-sm jb-grow" disabled={!!busy} onClick={addPayment}>
              {busy === 'pay' ? 'กำลังบันทึก...' : '💾 บันทึกการจ่าย'}
            </button>
          </div>
        </div>
      </div>

      {/* ---------- เลื่อนส่ง ---------- */}
      <div className="jb-card">
        <h3>
          <span>🔁 ช่างขอเลื่อนส่ง {delays.length > 0 && <span className="tag am">{delays.length} ครั้ง</span>}</span>
          {!showDelay && <button className="btn btn-ghost btn-sm" onClick={() => setShowDelay(true)}>➕ บันทึกเลื่อน</button>}
        </h3>
        {delays.length === 0 && !showDelay && <p className="jb-muted">ยังไม่เคยเลื่อน</p>}
        {delays.map((d) => (
          <div key={d.id} className="jb-list-line">
            <span className="jb-grow">
              ครั้งที่ {d.seq} · {ddmm(d.old_date)} → {ddmm(d.new_date)}
              {d.reason && <span className="jb-small"> · {d.reason}</span>}
            </span>
            <button className="icon-btn" title="ลบ" onClick={() => delDelay(d)}>🗑</button>
          </div>
        ))}
        {showDelay && (
          <div style={{ background: 'var(--petal)', borderRadius: 12, padding: 12, marginTop: 8 }}>
            <p className="jb-small" style={{ marginBottom: 8 }}>ครั้งที่ {delays.length + 1} · กำหนดเดิม {ddmm(job.due_date)}</p>
            <div className="jb-2col">
              <div className="jb-field">
                <label>วันส่งใหม่</label>
                <input type="date" value={delayDate} onChange={(e) => setDelayDate(e.target.value)} />
              </div>
              <div className="jb-field">
                <label>เหตุผล</label>
                <input value={delayReason} onChange={(e) => setDelayReason(e.target.value)} placeholder="เช่น สีหมด / ป่วย" />
              </div>
            </div>
            <div className="jb-row">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowDelay(false)}>ยกเลิก</button>
              <button className="btn btn-rose btn-sm jb-grow" disabled={!!busy} onClick={addDelay}>💾 บันทึกเลื่อน</button>
            </div>
          </div>
        )}
      </div>

      {/* ---------- เลขพัสดุที่ช่างส่งมา ---------- */}
      <div className="jb-card" style={{ borderColor: 'var(--pink)' }}>
        <h3><span>🚚 เลขพัสดุที่ช่างส่งมาหาร้าน</span></h3>
        <p className="jb-small" style={{ marginBottom: 8 }}>อยู่ในใบงานนี้เท่านั้น ไม่ไปปนกับออเดอร์ลูกค้า · ปกติช่างกรอกเอง (หลังขั้น 3) ร้านกรอกแทนได้</p>
        <div className="jb-row">
          <input className="jb-grow" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="ยังไม่ส่งเลข" />
          <button className="btn btn-rose btn-sm" disabled={!!busy || tracking === job.tracking} onClick={saveTracking}>บันทึก</button>
        </div>
        {job.tracking && (
          <p style={{ marginTop: 8, fontSize: 14 }}>
            {carrierOf(job.tracking) || 'ไม่รู้จักขนส่ง'}
            {job.tracking_at && <span className="jb-small"> · กรอกเมื่อ {ddmm(job.tracking_at.slice(0, 10))}</span>}
            {tkUrl && (
              <>
                {' · '}
                <a className="jb-link" href={tkUrl} target="_blank" rel="noreferrer">เช็กสถานะ ↗</a>
              </>
            )}
          </p>
        )}
      </div>

      {/* ---------- รูป ---------- */}
      <div className="jb-card">
        <h3>
          <span>📷 รูปบรีฟ / รูปงาน</span>
          <span className="jb-row">
            <select value={fileKind} onChange={(e) => setFileKind(e.target.value)} style={{ width: 'auto', padding: '6px 8px', fontSize: 13 }}>
              <option>รูปงาน</option>
              <option>บรีฟ</option>
            </select>
            <label className="btn btn-ghost btn-sm jb-upload" style={{ margin: 0 }}>
              {busy === 'file' ? 'กำลังอัป...' : '⬆ อัปรูป'}
              <input type="file" accept="image/*,application/pdf" multiple onChange={onUpload} disabled={!!busy} />
            </label>
          </span>
        </h3>
        {files.length === 0 ? (
          <p className="jb-muted">ยังไม่มีรูป</p>
        ) : (
          <div className="jb-files">
            {files.map((f) => (
              <div key={f.id} className="jb-file">
                <a href={fileUrl(f.path)} target="_blank" rel="noreferrer" style={{ display: 'contents' }}>
                  {isPdf(f.path) ? <span style={{ fontSize: 30 }}>📄</span> : <img src={fileUrl(f.path)} alt={f.kind} loading="lazy" />}
                </a>
                <span className="cap">{f.kind} · {f.uploaded_by}</span>
                <button className="x" title="ลบ" onClick={() => delFile(f)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- โน้ตภายใน ---------- */}
      <div className="jb-card">
        <h3><span>🔒 โน้ตภายใน (ช่างไม่เห็น)</span></h3>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 60 }} />
        {note !== job.internal_note && (
          <button
            className="btn btn-rose btn-sm"
            style={{ marginTop: 8 }}
            disabled={!!busy}
            onClick={() => run('note', () => updateJob({ internal_note: note.trim() }), '✅ บันทึกโน้ตแล้ว')}
          >
            บันทึกโน้ต
          </button>
        )}
      </div>

      <button className="btn btn-danger btn-sm" onClick={deleteJob} disabled={!!busy}>🗑 ลบใบงานนี้</button>
    </>
  )
}

/* =====================================================================
   รายชื่อช่าง
   ===================================================================== */
function ArtisanList({ artisans, jobs, say, refresh, onBack }) {
  const [editId, setEditId] = useState(null) // id | 'new' | null
  const [form, setForm] = useState({})
  const [showInactive, setShowInactive] = useState(false)
  const [saving, setSaving] = useState(false)

  const stats = useMemo(() => {
    const s = {}
    for (const j of jobs) {
      const x = (s[j.artisan_id] ||= { jobs: 0, open: 0, delays: 0, owe: 0 })
      x.jobs++
      if (j.status !== 'จ่ายเงินแล้ว') x.open++
      x.delays += (j.job_delays || []).length
      if (statusIdx(j.status) >= 2 && j.status !== 'จ่ายเงินแล้ว') x.owe = r2(x.owe + Math.max(0, jobTotals(j).balance))
    }
    return s
  }, [jobs])

  function open(a) {
    setEditId(a ? a.id : 'new')
    setForm(a ? { ...a } : { name: '', line_id: '', phone: '', id_card_ok: false, note: '', active: true })
  }

  async function save() {
    if (!(form.name || '').trim()) return say('ใส่ชื่อช่างก่อนนะคะ', false)
    setSaving(true)
    const row = {
      name: form.name.trim(),
      line_id: (form.line_id || '').trim(),
      phone: (form.phone || '').trim(),
      id_card_ok: !!form.id_card_ok,
      note: (form.note || '').trim(),
      active: !!form.active,
    }
    const { error } = editId === 'new' ? await supabase.from('artisans').insert(row) : await supabase.from('artisans').update(row).eq('id', editId)
    setSaving(false)
    if (error) return say('บันทึกไม่สำเร็จ: ' + error.message, false)
    setEditId(null)
    await refresh()
    say('✅ บันทึกข้อมูลช่างแล้ว')
  }

  async function toggleCard(a) {
    const { error } = await supabase.from('artisans').update({ id_card_ok: !a.id_card_ok }).eq('id', a.id)
    if (error) return say('บันทึกไม่สำเร็จ: ' + error.message, false)
    await refresh()
  }

  async function remove(a) {
    if (stats[a.id]?.jobs) return say('ช่างคนนี้มีใบงานอยู่ ลบไม่ได้ — ติ๊ก "ไม่ได้รับงานแล้ว" แทนนะคะ', false)
    if (!window.confirm(`ลบช่าง ${a.name} ใช่ไหม?`)) return
    const { error } = await supabase.from('artisans').delete().eq('id', a.id)
    if (error) return say('ลบไม่สำเร็จ: ' + error.message, false)
    setEditId(null)
    await refresh()
  }

  const list = artisans.filter((a) => showInactive || a.active)
  const noCard = artisans.filter((a) => a.active && !a.id_card_ok).length

  const Form = (
    <div style={{ background: 'var(--petal)', borderRadius: 12, padding: 12, marginTop: 8 }}>
      <div className="jb-2col">
        <div className="jb-field">
          <label>ชื่อ</label>
          <input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="jb-field">
          <label>LINE</label>
          <input value={form.line_id || ''} onChange={(e) => setForm({ ...form, line_id: e.target.value })} />
        </div>
        <div className="jb-field">
          <label>เบอร์</label>
          <input inputMode="tel" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="jb-field">
          <label>โน้ตภายใน</label>
          <input value={form.note || ''} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={!!form.id_card_ok} onChange={(e) => setForm({ ...form, id_card_ok: e.target.checked })} />
        ส่งบัตรประชาชนแล้ว
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={!form.active} onChange={(e) => setForm({ ...form, active: !e.target.checked })} />
        ไม่ได้รับงานแล้ว (ซ่อนจากตัวเลือก)
      </label>
      <div className="jb-row" style={{ marginTop: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>ยกเลิก</button>
        {editId !== 'new' && <button className="btn btn-danger btn-sm" onClick={() => remove(form)}>ลบ</button>}
        <button className="btn btn-rose btn-sm jb-grow" disabled={saving} onClick={save}>{saving ? 'กำลังบันทึก...' : '💾 บันทึก'}</button>
      </div>
    </div>
  )

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={onBack}>← รายการใบงาน</button>
      <div className="jb-card">
        <h3>
          <span>👩‍🎨 รายชื่อช่าง ({artisans.filter((a) => a.active).length})</span>
          {editId !== 'new' && <button className="btn btn-rose btn-sm" onClick={() => open(null)}>➕ เพิ่มช่าง</button>}
        </h3>
        {noCard > 0 && <p className="tag rd" style={{ marginBottom: 8 }}>ยังไม่มีบัตร ปชช. {noCard} คน</p>}
        {editId === 'new' && Form}

        {list.map((a) => {
          const s = stats[a.id] || { jobs: 0, open: 0, delays: 0, owe: 0 }
          return (
            <div key={a.id} className="jb-list-line" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="jb-row" style={{ justifyContent: 'space-between' }}>
                <span className="jb-name" style={{ fontSize: 16, opacity: a.active ? 1 : 0.55 }}>{a.name}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => (editId === a.id ? setEditId(null) : open(a))}>แก้</button>
              </div>
              <div className="jb-small">
                {[a.line_id && 'LINE ' + a.line_id, a.phone].filter(Boolean).join(' · ') || '—'}
              </div>
              <div>
                <button className={'tag ' + (a.id_card_ok ? 'gr' : 'rd')} style={{ border: 'none', cursor: 'pointer' }} onClick={() => toggleCard(a)} title="กดเพื่อสลับ">
                  {a.id_card_ok ? '✓ มีบัตร ปชช.' : 'ยังไม่มีบัตร ปชช.'}
                </button>
                <span className="tag gy">{s.jobs} ใบงาน · ค้าง {s.open}</span>
                {s.delays > 0 && <span className="tag am">🔁 เลื่อนรวม {s.delays} ครั้ง</span>}
                {s.owe > 0 && <span className="tag rd">ค้างจ่าย {baht(s.owe)} ฿</span>}
                {!a.active && <span className="tag gy">ไม่ได้รับงานแล้ว</span>}
              </div>
              {a.note && <div className="jb-small">🔒 {a.note}</div>}
              {editId === a.id && Form}
            </div>
          )
        })}
        {list.length === 0 && <p className="jb-muted">ยังไม่มีช่าง</p>}
        {artisans.some((a) => !a.active) && (
          <p className="mini-clear" onClick={() => setShowInactive(!showInactive)}>
            {showInactive ? 'ซ่อนช่างที่ไม่ได้รับงานแล้ว' : 'แสดงช่างที่ไม่ได้รับงานแล้วด้วย'}
          </p>
        )}
      </div>
    </>
  )
}
