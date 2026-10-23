import { useState, useEffect, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, genOrderCode } from './supabase'
import { CARRIERS, guessCarrier, hasShipped, shipText, TrackLink } from './carriers.jsx'
import NavSwitch from './NavSwitch.jsx'
import { parseBrief } from './briefParser.js'
import './jobs.css'

/* =====================================================================
   หลังร้าน: ระบบติดตามงานช่าง (/jobs)
   ข้อมูลอยู่คนละตารางกับออเดอร์ลูกค้า (artisans, artisan_jobs, job_*)
   ===================================================================== */

export const JOB_STATUSES = ['สั่งงาน', 'กำลังทำ', 'ช่างส่งของแล้ว', 'รับ/ตรวจแล้ว', 'จ่ายเงินแล้ว']
export const SIZES = ['S', 'M', 'L']
export const JOB_BUCKET = 'job-files'
const PAY_KINDS = ['มัดจำ', 'ปิดยอด', 'อื่นๆ']
export const PAY_TERMS = ['จ่ายทีหลัง', 'มัดจำก่อน'] // ตกลงกับช่าง: จ่ายตอนรับของ / ต้องโอนมัดจำก่อนเริ่มงาน
export const payTermOf = (job) => (job.pay_term === 'มัดจำก่อน' ? 'มัดจำก่อน' : 'จ่ายทีหลัง')
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
export const dueText = (iso) => (iso ? ddmm(iso) : 'ไม่ได้กำหนดวันส่ง')
// อีกกี่วันถึงกำหนด (ติดลบ = เลยมาแล้ว)
export function daysUntil(iso) {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date()
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 864e5)
}
export function relDue(iso) {
  const n = daysUntil(iso)
  if (n == null) return 'ไม่ได้กำหนดวันส่ง'
  if (n < 0) return `เลยกำหนด ${-n} วัน`
  if (n === 0) return 'ครบกำหนดวันนี้'
  if (n === 1) return 'ครบกำหนดพรุ่งนี้'
  return `อีก ${n} วัน`
}
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
  if (artisan && artisan.in_flow === false) f.push({ t: 'ยังไม่มีใน Flow', c: 'am' })
  if (si < 2 && job.due_date && job.due_date < today) f.push({ t: '⏰ เลยกำหนด ' + ddmm(job.due_date), c: 'rd' })
  else if (si < 2 && !hasShipped(job) && job.due_date && job.due_date <= addDays(today, 1)) f.push({ t: '⏰ ' + relDue(job.due_date) + ' · ยังไม่ส่ง', c: 'am' })
  if (hasShipped(job)) f.push({ t: '🚚 ' + (shipText(job) || 'ช่างส่งของแล้ว'), c: 'tl' })
  const nd = (job.job_delays || []).length
  if (nd) f.push({ t: `🔁 เลื่อน ${nd} ครั้ง`, c: 'am' })
  // สถานะเงิน
  if (si >= 3 && t.balance > 0) f.push({ t: `ค้างจ่าย ${baht(t.balance)} ฿`, c: 'rd' })
  else if (t.paid <= 0 && t.amount > 0)
    f.push(payTermOf(job) === 'มัดจำก่อน' ? { t: '💸 ยังไม่โอนมัดจำ', c: 'rd' } : { t: 'ยังไม่โอน · จ่ายทีหลัง', c: 'gy' })
  else if (t.balance > 0) f.push({ t: `โอนแล้ว ${baht(t.paid)} ฿`, c: 'gr' })
  else if (t.amount > 0) f.push({ t: 'จ่ายครบ', c: 'gr' })
  return f
}
const Tags = ({ list }) => list.map((x, i) => <span key={i} className={'tag ' + x.c}>{x.t}</span>)

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
  ['unpaid', 'ยังไม่โอน'],
  ['topay', 'รอจ่าย'],
  ['done', 'จ่ายเงินแล้ว'],
  ['all', 'ทั้งหมด'],
]

function JobList({ jobs, artById, artisans, filter, setFilter, q, setQ, onOpen, onNew, onArtisans }) {
  const today = todayIso()
  const test = {
    open: (j) => j.status !== 'จ่ายเงินแล้ว',
    late: (j) => statusIdx(j.status) < 2 && j.due_date && j.due_date < today,
    unpaid: (j) => j.status !== 'จ่ายเงินแล้ว' && jobTotals(j).paid <= 0,
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
      const hay = [a && artisanHay(a), j.code, j.brief, ...(j.job_items || []).map((i) => i.design)].join(' ').toLowerCase()
      return hay.includes(needle)
    })
    .sort((x, y) => {
      // งานยังไม่จบขึ้นก่อน แล้วเรียงตามกำหนดส่งใกล้สุด
      const dx = x.status === 'จ่ายเงินแล้ว' ? 1 : 0
      const dy = y.status === 'จ่ายเงินแล้ว' ? 1 : 0
      if (dx !== dy) return dx - dy
      return (x.due_date || '9999').localeCompare(y.due_date || '9999')
    })

  // ---------- ใกล้มาถึง: เลยกำหนด / ครบกำหนดวันนี้-พรุ่งนี้ / ช่างส่งของแล้ว กำลังมา ----------
  const RANK = { late: 0, soon: 1, coming: 2 }
  const near = jobs
    .map((j) => {
      const si = statusIdx(j.status)
      if (si === 2) return { j, kind: 'coming' }
      if (si < 2 && j.due_date && j.due_date < today) return { j, kind: 'late' }
      if (si < 2 && j.due_date && j.due_date <= addDays(today, 1)) return { j, kind: 'soon' }
      return null
    })
    .filter(Boolean)
    .sort((x, y) => RANK[x.kind] - RANK[y.kind] || (x.j.due_date || '9999').localeCompare(y.j.due_date || '9999'))

  return (
    <>
      <div className="jb-row" style={{ marginBottom: 4 }}>
        <button className="btn btn-rose" style={{ flex: 1 }} onClick={onNew}>➕ สร้างใบงานใหม่</button>
        <button className="btn btn-ghost" onClick={onArtisans}>👩‍🎨 รายชื่อช่าง ({artisans.length})</button>
      </div>

      {near.length > 0 && (
        <div className="jb-card jb-near">
          <h3 style={{ marginBottom: 6 }}><span>📦 ใกล้มาถึง ({near.length})</span></h3>
          {near.map(({ j, kind }) => {
            const a = artById[j.artisan_id]
            const t = jobTotals(j)
            return (
              <div key={j.id} className="jb-near-row" onClick={() => onOpen(j.id)} role="button">
                <span className={'tag ' + (kind === 'late' ? 'rd' : kind === 'soon' ? 'am' : 'tl')} style={{ margin: 0 }}>
                  {kind === 'coming' ? '🚚 กำลังมา' : relDue(j.due_date)}
                </span>
                <span className="jb-grow">
                  <b style={{ fontWeight: 400, color: 'var(--plum)' }}>{artisanShort(a)}</b>
                  <span className="jb-small"> · {t.qty} ชุด{kind === 'coming' && shipText(j) ? ' · ' + shipText(j) : ''}</span>
                </span>
                {kind === 'coming' && (
                  <span onClick={(e) => e.stopPropagation()}>
                    <TrackLink tk={j.tracking} carrier={j.tracking_carrier} className="jb-link">เช็ก ↗</TrackLink>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="jb-chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={'jb-chip' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>
            {label} {counts[k]}
          </button>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 ค้นหา ชื่อช่าง / ชื่อเฟส / ลาย / เลขงาน" style={{ marginBottom: 12 }} />

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
              <span className="jb-name">{artisanShort(a)}</span>
              <span className="tag pk" style={{ marginTop: 2 }}>{j.status}</span>
            </div>
            {a?.facebook && <div className="jb-small">FB {a.facebook}</div>}
            <div className="jb-muted">
              {t.designs} ลาย · {t.qty} ชุด · {baht(t.amount)} ฿ · {j.due_date ? 'ส่ง ' + ddmm(j.due_date) : 'ไม่ได้กำหนดวันส่ง'}
            </div>
            <Tags list={jobFlags(j, a)} />
          </button>
        )
      })}
    </>
  )
}

/* =====================================================================
   รายการแบบ "การ์ดต่อลาย": รูป ref + S/M/L + ราคา (ลายเดียวหลายไซส์อยู่การ์ดเดียว)
   ในฐานข้อมูลยังเก็บเป็นแถวละไซส์ (job_items) · รูปผูกกับลายด้วย job_files.design
   ===================================================================== */

// แถวจากฐานข้อมูล → กลุ่มตามลาย (+ราคา)
export function groupItems(items) {
  const map = new Map()
  for (const i of [...(items || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || (a.id ?? 0) - (b.id ?? 0))) {
    const design = (i.design || '').trim() || 'ตามรูป'
    const key = design + '|' + r2(i.price)
    if (!map.has(key)) map.set(key, { design, price: r2(i.price), sizes: [] })
    map.get(key).sizes.push(i)
  }
  return [...map.values()].map((g) => {
    g.sizes.sort((a, b) => SIZES.indexOf(a.size) - SIZES.indexOf(b.size))
    g.qty = g.sizes.reduce((s, i) => s + (Number(i.qty) || 0), 0)
    g.amount = r2(g.qty * g.price)
    g.anyRecv = g.sizes.some((i) => i.qty_received != null)
    return g
  })
}

let gid = 0
const emptySz = () => ({ qty: '', recv: '', dmg: '' })
const newGroup = (design = '', price = '') => ({ key: ++gid, design, price, S: emptySz(), M: emptySz(), L: emptySz(), photos: [] })

function addSz(g, size, qty, recv, dmg) {
  const cur = g[size] || emptySz()
  const plus = (a, b) => (a === '' && (b === '' || b == null) ? '' : String((Number(a) || 0) + (Number(b) || 0)))
  g[size] = { qty: plus(cur.qty, qty), recv: recv == null || recv === '' ? cur.recv : plus(cur.recv, recv), dmg: dmg == null || dmg === '' ? cur.dmg : plus(cur.dmg, dmg) }
}

function groupsFromItems(items) {
  return groupItems(items).map((g) => {
    const ng = newGroup(g.design === 'ตามรูป' ? '' : g.design, g.price ? String(g.price) : '')
    ng.origDesign = g.design
    for (const i of g.sizes) addSz(ng, SIZES.includes(i.size) ? i.size : 'M', i.qty, i.qty_received, i.qty_damaged)
    return ng
  })
}

// ผลจากตัวแยกบรีฟ (แถวละไซส์) → กลุ่ม
function groupsFromParsed(items) {
  const map = new Map()
  for (const i of items) {
    const d = i.design === 'ตามรูป' ? '' : i.design || ''
    const key = d + '|' + (i.price || '')
    if (!map.has(key)) map.set(key, newGroup(d, i.price || ''))
    addSz(map.get(key), i.size, i.qty)
  }
  return [...map.values()]
}

// ลายที่ไม่ได้ตั้งชื่อ: มีลายเดียว = "ตามรูป" · หลายลาย = "ตามรูป 1", "ตามรูป 2" (รูปจะได้ไม่ปนกัน)
function nameGroups(groups) {
  const blank = groups.filter((g) => !g.design.trim()).length
  let n = 0
  return groups.map((g) => (g.design.trim() ? { ...g, design: g.design.trim() } : { ...g, design: blank > 1 ? `ตามรูป ${++n}` : 'ตามรูป' }))
}

function rowsFromGroups(groups) {
  const rows = []
  for (const g of nameGroups(groups))
    for (const sz of SIZES) {
      const v = g[sz]
      if (Number(v.qty) > 0 || v.recv !== '')
        rows.push({ design: g.design, size: sz, qty: v.qty, price: g.price, qty_received: v.recv, qty_damaged: v.dmg })
    }
  return rows
}

const groupQty = (g) => SIZES.reduce((s, z) => s + (Number(g[z].qty) || 0), 0)

function GroupsEditor({ groups, setGroups, showReceive, allowPhotos }) {
  const upd = (k, patch) => setGroups(groups.map((g) => (g.key === k ? { ...g, ...patch } : g)))
  const updSz = (k, sz, f, v) => setGroups(groups.map((g) => (g.key === k ? { ...g, [sz]: { ...g[sz], [f]: v } } : g)))
  const del = (k) => {
    const g = groups.find((x) => x.key === k)
    ;(g?.photos || []).forEach((p) => URL.revokeObjectURL(p.url))
    setGroups(groups.filter((x) => x.key !== k))
  }
  const addPhotos = (k, e) => {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    const g = groups.find((x) => x.key === k)
    upd(k, { photos: [...g.photos, ...list.map((file) => ({ file, url: URL.createObjectURL(file) }))] })
  }
  const delPhoto = (k, i) => {
    const g = groups.find((x) => x.key === k)
    URL.revokeObjectURL(g.photos[i].url)
    upd(k, { photos: g.photos.filter((_, n) => n !== i) })
  }
  const num = (v) => v.replace(/\D/g, '')
  const total = r2(groups.reduce((s, g) => s + groupQty(g) * (Number(g.price) || 0), 0))
  const qty = groups.reduce((s, g) => s + groupQty(g), 0)

  return (
    <>
      {groups.map((g, n) => (
        <div key={g.key} className="jb-dedit">
          <div className="jb-row" style={{ marginBottom: 8 }}>
            <span className="jb-dnum">{n + 1}</span>
            <input className="jb-grow" value={g.design} onChange={(e) => upd(g.key, { design: e.target.value })} placeholder="ชื่อลาย (เว้นว่าง = ตามรูป)" />
            <button className="icon-btn" title="ลบลายนี้" onClick={() => del(g.key)}>🗑</button>
          </div>

          {allowPhotos && (
            <div className="jb-row" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
              {g.photos.map((p, i) => (
                <div key={p.url} className="jb-file" style={{ width: 64 }}>
                  {/pdf/.test(p.file.type) ? <span style={{ fontSize: 24 }}>📄</span> : <img src={p.url} alt="ref" />}
                  <button className="x" title="เอาออก" onClick={() => delPhoto(g.key, i)}>✕</button>
                </div>
              ))}
              <label className="jb-addphoto">
                📷<span>{g.photos.length ? 'เพิ่ม' : 'รูป ref'}</span>
                <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => addPhotos(g.key, e)} />
              </label>
            </div>
          )}

          <div className="jb-sizes">
            {SIZES.map((sz) => (
              <div key={sz} className="jb-size">
                <span className="jb-sz">{sz}</span>
                <input inputMode="numeric" value={g[sz].qty} onChange={(e) => updSz(g.key, sz, 'qty', num(e.target.value))} placeholder="0" />
                {showReceive && (
                  <>
                    <input inputMode="numeric" value={g[sz].recv} onChange={(e) => updSz(g.key, sz, 'recv', num(e.target.value))} placeholder="รับ" title="รับจริง" />
                    <input inputMode="numeric" value={g[sz].dmg} onChange={(e) => updSz(g.key, sz, 'dmg', num(e.target.value))} placeholder="ชำรุด" title="ชำรุด" />
                  </>
                )}
              </div>
            ))}
          </div>
          {showReceive && <p className="jb-small" style={{ marginTop: 2 }}>ช่องบน = สั่ง · ช่องกลาง = รับจริง · ช่องล่าง = ชำรุด</p>}

          <div className="jb-row" style={{ marginTop: 8 }}>
            <span className="jb-small">ชุดละ</span>
            <input inputMode="decimal" style={{ width: 90 }} value={g.price} onChange={(e) => upd(g.key, { price: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0" />
            <span className="jb-grow" style={{ textAlign: 'right', fontSize: 14 }}>
              {groupQty(g)} ชุด · {baht(groupQty(g) * (Number(g.price) || 0))} ฿
            </span>
          </div>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={() => setGroups([...groups, newGroup()])}>➕ เพิ่มลาย</button>
      <div className="jb-total"><span>รวม {qty} ชุด</span><span>{baht(total)} ฿</span></div>
    </>
  )
}

// แสดงรายการแบบการ์ดต่อลาย (หลังร้าน + หน้าช่าง)
export function DesignCards({ items, files = [], onAddPhoto, onDelFile, busy }) {
  const groups = groupItems(items)
  const filesOf = (d) => files.filter((f) => (f.design || '') === d || (d === 'ตามรูป' && f.design === 'ตามรูป'))
  if (!groups.length) return <p className="jb-muted">ยังไม่มีรายการ</p>
  return (
    <div>
      {groups.map((g, n) => {
        const ph = filesOf(g.design)
        return (
          <div key={n} className="jb-dcard">
            <div className="jb-dthumb">
              {ph.length ? (
                <a href={fileUrl(ph[0].path)} target="_blank" rel="noreferrer">
                  {isPdf(ph[0].path) ? <span style={{ fontSize: 30 }}>📄</span> : <img src={fileUrl(ph[0].path)} alt={g.design} loading="lazy" />}
                </a>
              ) : (
                <span className="jb-small">ไม่มีรูป</span>
              )}
              {ph.length > 1 && <span className="jb-more">+{ph.length - 1}</span>}
            </div>
            <div className="jb-dbody">
              <div className="jb-dtitle">{g.design}</div>
              <div className="jb-dsizes">
                {g.sizes.map((i, k) => (
                  <span key={k} className="jb-szpill">
                    {i.size} <b>{i.qty}</b>
                    {i.qty_received != null && (
                      <em>
                        {' '}รับ {i.qty_received}
                        {i.qty_damaged ? ` · ชำรุด ${i.qty_damaged}` : ''}
                      </em>
                    )}
                  </span>
                ))}
              </div>
              <div className="jb-small">
                {g.qty} ชุด · ชุดละ {baht(g.price)} = <b style={{ color: 'var(--pink-deep)', fontWeight: 400 }}>{baht(g.amount)} ฿</b>
              </div>
              {(ph.length > 1 || onAddPhoto) && (
                <div className="jb-row" style={{ marginTop: 6, gap: 6 }}>
                  {ph.slice(1).map((f, k) => (
                    <a key={k} href={fileUrl(f.path)} target="_blank" rel="noreferrer" className="jb-mini">
                      {isPdf(f.path) ? '📄' : <img src={fileUrl(f.path)} alt="" loading="lazy" />}
                    </a>
                  ))}
                  {onAddPhoto && (
                    <label className="jb-addphoto small" title="เพิ่มรูป ref ของลายนี้">
                      📷<span>+รูป</span>
                      <input type="file" accept="image/*,application/pdf" multiple disabled={busy} onChange={(e) => onAddPhoto(g.design, e)} />
                    </label>
                  )}
                  {onDelFile && ph.length > 0 && (
                    <button className="icon-btn" title="ลบรูปของลายนี้ทีละรูป" onClick={() => onDelFile(ph[ph.length - 1])}>
                      🗑 รูปล่าสุด
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// รูปที่ไม่ได้ผูกกับลายไหน (รูปรวม / รูปส่งงานจากช่าง)
export function looseFiles(items, files) {
  const names = new Set(groupItems(items).map((g) => g.design))
  return (files || []).filter((f) => !f.design || !names.has(f.design))
}

function cleanItems(rows, jobId) {
  return rows
    .filter((r) => (r.design || '').trim() || Number(r.qty) > 0)
    .map((r, i) => ({
      job_id: jobId,
      sort: i,
      design: (r.design || '').trim() || 'ตามรูป', // สั่งแค่แนบรูป = "ตามรูป"
      size: SIZES.includes(r.size) ? r.size : 'M',
      qty: Math.max(0, Number(r.qty) || 0),
      price: r2(r.price),
      qty_received: numOrNull(r.qty_received),
      qty_damaged: numOrNull(r.qty_damaged),
    }))
}

// ชื่อช่างที่แสดงในเว็บ: "065 บีม · จินห์วรา หนูทองแก้ว"
export function artisanLabel(a) {
  if (!a) return '(ไม่พบช่าง)'
  const nick = a.nickname && a.nickname !== a.name ? a.nickname : ''
  return [a.code, nick, nick ? '· ' + a.name : a.name, a.facebook ? `(FB ${a.facebook})` : ''].filter(Boolean).join(' ')
}
export function artisanShort(a) {
  if (!a) return '(ไม่พบช่าง)'
  return a.nickname && a.nickname !== a.name ? `${a.nickname} (${a.name})` : a.name
}
const artisanHay = (a) => [a.code, a.name, a.nickname, a.facebook].filter(Boolean).join(' ').toLowerCase()
export const sortArtisans = (list) =>
  [...list].sort((x, y) => (x.code || 'zzz').localeCompare(y.code || 'zzz') || (x.name || '').localeCompare(y.name || '', 'th'))

/* =====================================================================
   สร้างใบงานใหม่
   ===================================================================== */
function NewJob({ artisans, say, onCancel, onCreated }) {
  const active = sortArtisans(artisans.filter((a) => a.active))
  const [artisanId, setArtisanId] = useState('')
  const [findQ, setFindQ] = useState('')
  const [newName, setNewName] = useState('')
  const [newFb, setNewFb] = useState('')
  const [orderDate, setOrderDate] = useState(todayIso())
  const [dueDate, setDueDate] = useState('') // ว่าง = ไม่ได้กำหนดวันส่ง
  const [brief, setBrief] = useState('')
  const [note, setNote] = useState('')
  const [groups, setGroups] = useState(() => [newGroup()])
  const [payTerm, setPayTerm] = useState('จ่ายทีหลัง')
  const [paste, setPaste] = useState('')
  const [saving, setSaving] = useState(false)
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  // ปิดหน้า → คืนหน่วยความจำรูปตัวอย่าง
  useEffect(() => () => groupsRef.current.forEach((g) => g.photos.forEach((p) => URL.revokeObjectURL(p.url))), [])

  const needle = findQ.trim().toLowerCase()
  const options = needle ? active.filter((a) => artisanHay(a).includes(needle)) : active
  const chosen = active.find((a) => String(a.id) === artisanId)

  // ช่องค้นหาเหลือคนเดียว → เลือกให้เลย
  useEffect(() => {
    if (needle && options.length === 1) setArtisanId(String(options[0].id))
  }, [findQ]) // eslint-disable-line

  async function pasteFromClipboard() {
    try {
      const t = await navigator.clipboard.readText()
      if (t && t.trim()) setPaste(t)
      else say('คลิปบอร์ดว่างอยู่ค่ะ', false)
    } catch {
      say('เครื่องนี้ไม่ให้กดวางอัตโนมัติ — กดค้างในช่องแล้วเลือก "วาง" แทนนะคะ', false)
    }
  }

  function applyPaste() {
    if (!paste.trim()) return say('วางข้อความบรีฟก่อนนะคะ', false)
    const r = parseBrief(paste, active)
    const got = []
    if (r.artisanId) {
      setArtisanId(String(r.artisanId))
      setFindQ('')
      got.push('ช่าง')
    }
    if (r.dueDate) {
      setDueDate(r.dueDate)
      got.push('กำหนดส่ง ' + ddmm(r.dueDate))
    }
    if (r.items.length) {
      const ng = groupsFromParsed(r.items)
      // เก็บรูปที่แนบไว้แล้วในลายแรก (ถ้ามี) ไม่ให้หาย
      const keep = groups.flatMap((g) => g.photos)
      if (keep.length) ng[0].photos = keep
      setGroups(ng)
      got.push(`${ng.length} ลาย`)
    }
    if (r.brief) {
      setBrief((b) => (b.trim() ? b.trim() + '\n' + r.brief : r.brief))
      got.push('บรีฟ')
    }
    say(got.length ? '✨ กรอกให้แล้ว: ' + got.join(' · ') + ' — เช็กอีกทีก่อนบันทึกนะคะ' : 'อ่านไม่เจอข้อมูล ลองพิมพ์ไซส์+จำนวน เช่น "M 50" ดูค่ะ', got.length > 0)
  }

  async function save() {
    const named = nameGroups(groups)
    const items = cleanItems(rowsFromGroups(groups), 0)
    if (!artisanId) return say('เลือกช่างก่อนนะคะ', false)
    if (artisanId === 'new' && !newName.trim()) return say('ใส่ชื่อช่างก่อนนะคะ', false)
    if (!items.length) return say('ใส่จำนวนอย่างน้อย 1 ไซส์', false)
    setSaving(true)
    try {
      let aid = Number(artisanId)
      if (artisanId === 'new') {
        const { data, error } = await supabase.from('artisans').insert({ name: newName.trim(), facebook: newFb.trim() }).select().single()
        if (error) throw error
        aid = data.id
      }
      const { data: job, error } = await supabase
        .from('artisan_jobs')
        .insert({ code: genOrderCode(), artisan_id: aid, order_date: orderDate || todayIso(), due_date: dueDate || null, pay_term: payTerm, brief: brief.trim(), internal_note: note.trim() })
        .select()
        .single()
      if (error) throw error
      const { error: e2 } = await supabase.from('job_items').insert(cleanItems(rowsFromGroups(groups), job.id))
      if (e2) throw e2
      // รูป ref ต่อลาย — อัปหลังได้เลขงานแล้ว (ถ้าบางรูปพัง ใบงานยังอยู่ แนบเพิ่มในหน้าใบงานได้)
      let failed = 0
      for (const g of named)
        for (const p of g.photos) {
          try {
            const path = await uploadJobFile(job.code, p.file)
            const { error: e3 } = await supabase.from('job_files').insert({ job_id: job.id, path, kind: 'บรีฟ', uploaded_by: 'ร้าน', design: g.design })
            if (e3) throw e3
          } catch {
            failed++
          }
        }
      say(failed ? `✅ สร้างใบงานแล้ว แต่รูปอัปไม่ได้ ${failed} รูป — แนบใหม่ในหน้าใบงานได้` : '✅ สร้างใบงานแล้ว', !failed)
      await onCreated(job.id)
    } catch (e) {
      say('บันทึกไม่สำเร็จ: ' + e.message, false)
    } finally {
      setSaving(false)
    }
  }

  const nPhotos = groups.reduce((s, g) => s + g.photos.length, 0)

  return (
    <div className="jb-card">
      <h3>
        <span>➕ ใบงานใหม่</span>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>ยกเลิก</button>
      </h3>

      {/* ---------- วางบรีฟ → กรอกช่องให้ ---------- */}
      <div className="paste-wrap" style={{ marginBottom: 14 }}>
        <div className="jb-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={{ margin: 0 }}>📋 วางข้อความบรีฟ (ไม่บังคับ)</label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={pasteFromClipboard}>📋 วาง</button>
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          style={{ minHeight: 90 }}
          placeholder={'เช่น\nช่างบีม ลายหินอ่อน S 20 M 30\nลายดอกไม้ 20M 10L\nชุดละ 45 ส่ง 30/10\nแพ็กถุงซิปทีละชุด'}
        />
        <button className="btn btn-rose btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={applyPaste}>✨ แยกข้อมูลลงช่องด้านล่าง</button>
      </div>

      {/* ---------- ช่าง ---------- */}
      <div className="jb-field">
        <label>ช่าง</label>
        <input value={findQ} onChange={(e) => setFindQ(e.target.value)} placeholder="🔍 ค้นหา รหัส / ชื่อ / ชื่อในใบ / ชื่อเฟส" style={{ marginBottom: 6 }} />
        <select value={artisanId} onChange={(e) => setArtisanId(e.target.value)}>
          <option value="">— เลือกช่าง ({options.length}) —</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {artisanLabel(a)}
              {a.id_card_ok ? '' : ' ⚠บัตร'}
            </option>
          ))}
          <option value="new">➕ ช่างใหม่...</option>
        </select>
        {chosen && (
          <div style={{ marginTop: 4 }}>
            {chosen.facebook && <span className="tag gy">FB {chosen.facebook}</span>}
            {!chosen.id_card_ok && <span className="tag rd">ยังไม่มีบัตร ปชช.</span>}
            {chosen.in_flow === false && <span className="tag am">ยังไม่มีใน Flow</span>}
          </div>
        )}
        {artisanId === 'new' && (
          <div className="jb-2col" style={{ marginTop: 8 }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ชื่อช่างใหม่" autoFocus />
            <input value={newFb} onChange={(e) => setNewFb(e.target.value)} placeholder="ชื่อ Facebook" />
          </div>
        )}
      </div>

      <div className="jb-2col">
        <div className="jb-field">
          <label>วันสั่งงาน</label>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div className="jb-field">
          <label>กำหนดส่ง {dueDate && <span className="mini-x" style={{ cursor: 'pointer' }} onClick={() => setDueDate('')}>✕ ไม่กำหนด</span>}</label>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          {!dueDate && <p className="jb-small" style={{ marginTop: 3 }}>ไม่ได้กำหนดวันส่ง</p>}
        </div>
      </div>

      <div className="jb-field">
        <label>เงื่อนไขจ่ายช่าง</label>
        <div className="jb-row">
          {PAY_TERMS.map((x) => (
            <button key={x} type="button" className={'jb-chip' + (payTerm === x ? ' on' : '')} onClick={() => setPayTerm(x)}>
              {x === 'จ่ายทีหลัง' ? '🕒 จ่ายทีหลัง (ตอนรับของ)' : '💸 โอนมัดจำก่อน'}
            </button>
          ))}
        </div>
      </div>

      <label>🎨 รายการ — แนบรูป ref ไว้ในแต่ละลาย</label>
      <GroupsEditor groups={groups} setGroups={setGroups} allowPhotos />

      <div className="jb-field" style={{ marginTop: 12 }}>
        <label>บรีฟ / หมายเหตุ (ช่างเห็น)</label>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="สี ทรง ความยาว แพ็กแบบไหน ฯลฯ" style={{ minHeight: 60 }} />
      </div>

      <div className="jb-field">
        <label>โน้ตภายใน (ช่างไม่เห็น)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="ไม่บังคับ" style={{ minHeight: 56 }} />
      </div>

      <button className="btn btn-rose" style={{ width: '100%' }} onClick={save} disabled={saving}>
        {saving ? (nPhotos ? `กำลังบันทึก + อัปรูป ${nPhotos} รูป...` : 'กำลังบันทึก...') : '💾 บันทึกใบงาน'}
      </button>
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
  const [groups, setGroups] = useState([])
  const [editBrief, setEditBrief] = useState(false)
  const [brief, setBrief] = useState(job.brief)
  const [note, setNote] = useState(job.internal_note)
  const [tracking, setTracking] = useState(job.tracking)
  const [carrier, setCarrier] = useState(job.tracking_carrier || guessCarrier(job.tracking))
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
    setCarrier(job.tracking_carrier || guessCarrier(job.tracking))
  }, [job.tracking, job.tracking_carrier])

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
      say('📋 คัดลอกลิงก์ช่างแล้ว — ส่งให้ช่างทาง LINE ได้เลย')
    } catch {
      window.prompt('คัดลอกลิงก์นี้', link)
    }
  }

  function startEditItems() {
    setGroups(groupsFromItems(items))
    setEditItems(true)
  }

  function saveItems() {
    const clean = cleanItems(rowsFromGroups(groups), job.id)
    if (!clean.length) return say('ต้องมีอย่างน้อย 1 แถว', false)
    if (!window.confirm('บันทึกรายการที่แก้ใช่ไหมคะ?')) return
    run(
      'items',
      async () => {
        await supabase.from('job_items').delete().eq('job_id', job.id).then(must)
        await supabase.from('job_items').insert(clean).then(must)
        // เปลี่ยนชื่อลาย → ย้ายรูปของลายนั้นตามไปด้วย
        const named = nameGroups(groups)
        for (const g of named)
          if (g.origDesign && g.origDesign !== g.design)
            await supabase.from('job_files').update({ design: g.design }).eq('job_id', job.id).eq('design', g.origDesign).then(must)
        setEditItems(false)
      },
      '✅ บันทึกรายการแล้ว'
    )
  }

  function saveTracking() {
    const tk = (tracking || '').replace(/\s/g, '').toUpperCase()
    const c = carrier || guessCarrier(tk)
    const shipped = !!tk || c === 'มาส่งเอง'
    const patch = { tracking: c === 'มาส่งเอง' ? '' : tk, tracking_carrier: shipped ? c : '', tracking_at: shipped ? new Date().toISOString() : null }
    if (shipped && statusIdx(job.status) < 2) patch.status = 'ช่างส่งของแล้ว'
    run('track', () => updateJob(patch), shipped ? '✅ บันทึกการส่งของแล้ว' : 'ลบเลขพัสดุแล้ว')
  }

  // เพิ่มรูป ref ให้ลาย
  function addDesignPhoto(design, e) {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    if (!list.length) return
    run(
      'file',
      async () => {
        for (const f of list) {
          const path = await uploadJobFile(job.code, f)
          await supabase.from('job_files').insert({ job_id: job.id, path, kind: 'บรีฟ', uploaded_by: 'ร้าน', design }).then(must)
        }
      },
      `✅ เพิ่มรูปให้ลาย "${design}" แล้ว`
    )
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
          await supabase.from('job_files').insert({ job_id: job.id, path, kind: fileKind, uploaded_by: 'ร้าน', design: '' }).then(must)
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
    const name = artisanShort(artisan)
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

  const loose = looseFiles(items, files)

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={onBack}>← รายการใบงาน</button>

      {/* ---------- หัวใบงาน ---------- */}
      <div className="jb-card">
        <div className="jb-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="jb-grow">
            <div className="jb-name" style={{ fontSize: 20 }}>{artisanShort(artisan)}</div>
            {(artisan?.code || artisan?.facebook) && <div className="jb-small">{[artisan.code && 'รหัส ' + artisan.code, artisan.facebook && 'FB ' + artisan.facebook].filter(Boolean).join(' · ')}</div>}
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
              {ddmm(job.order_date)} → <b style={{ color: 'var(--pink-deep)', fontWeight: 400 }}>{dueText(job.due_date)}</b>
              {delays.length > 0 && <span className="jb-small"> (เดิม {dueText(delays[0].old_date)})</span>}
              {job.due_date && statusIdx(job.status) < 2 && <div className="jb-small">{relDue(job.due_date)}</div>}
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
          <GroupsEditor groups={groups} setGroups={setGroups} showReceive />
        ) : (
          <>
            <DesignCards items={items} files={files} onAddPhoto={addDesignPhoto} onDelFile={delFile} busy={!!busy} />
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
        <h3>
          <span>💸 จ่ายเงินช่าง</span>
          <select
            value={payTermOf(job)}
            disabled={!!busy}
            onChange={(e) => run('term', () => updateJob({ pay_term: e.target.value }), 'เปลี่ยนเงื่อนไขจ่ายแล้ว')}
            style={{ width: 'auto', padding: '6px 8px', fontSize: 13 }}
            title="เงื่อนไขจ่าย"
          >
            {PAY_TERMS.map((x) => <option key={x}>{x}</option>)}
          </select>
        </h3>
        {payments.length === 0 && (
          <p className="jb-muted" style={{ marginBottom: 8, color: payTermOf(job) === 'มัดจำก่อน' ? '#B42318' : undefined }}>
            {payTermOf(job) === 'มัดจำก่อน' ? 'ยังไม่โอนมัดจำ — ตกลงไว้ว่าต้องโอนก่อนเริ่มงาน' : 'ยังไม่โอน — ตกลงกันว่าจ่ายทีหลัง (ตอนรับของ)'}
          </p>
        )}
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

      {/* ---------- ขนส่งที่ช่างส่งมา ---------- */}
      <div className="jb-card" style={{ borderColor: 'var(--pink)' }}>
        <h3><span>🚚 ช่างส่งของมาร้าน</span></h3>
        {hasShipped(job) ? (
          <p style={{ fontSize: 14, marginBottom: 8 }}>
            {shipText(job)}
            {job.tracking_at && <span className="jb-small"> · แจ้งเมื่อ {ddmm(job.tracking_at.slice(0, 10))}</span>}
            {' '}
            <TrackLink tk={job.tracking} carrier={job.tracking_carrier} className="jb-link" onCopied={() => say('📋 คัดลอกเลขพัสดุแล้ว ไปวางในเว็บขนส่งได้เลย')} />
          </p>
        ) : (
          <p className="jb-muted" style={{ marginBottom: 8 }}>ช่างยังไม่แจ้งส่งของ</p>
        )}
        <p className="jb-small" style={{ marginBottom: 6 }}>ปกติช่างกรอกเองในลิงก์ช่าง · ร้านกรอก/แก้แทนได้ · อยู่ในใบงานนี้เท่านั้น ไม่ปนออเดอร์ลูกค้า</p>
        <div className="jb-row">
          <select value={carrier} onChange={(e) => setCarrier(e.target.value)} style={{ width: 'auto', padding: '9px 8px' }}>
            <option value="">ขนส่ง</option>
            {CARRIERS.map((c) => <option key={c}>{c}</option>)}
          </select>
          {carrier !== 'มาส่งเอง' && (
            <input className="jb-grow" style={{ minWidth: 120 }} value={tracking} onChange={(e) => { setTracking(e.target.value); if (!carrier) setCarrier(guessCarrier(e.target.value)) }} placeholder="เลขพัสดุ" />
          )}
          <button className="btn btn-rose btn-sm" disabled={!!busy || (tracking === job.tracking && carrier === (job.tracking_carrier || guessCarrier(job.tracking)))} onClick={saveTracking}>บันทึก</button>
        </div>
      </div>

      {/* ---------- รูป ---------- */}
      <div className="jb-card">
        <h3>
          <span>📷 รูปอื่นๆ / รูปส่งงานจากช่าง</span>
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
        {loose.length === 0 ? (
          <p className="jb-muted">ยังไม่มีรูป (รูป ref ของแต่ละลายอยู่ในการ์ดรายการด้านบน)</p>
        ) : (
          <div className="jb-files">
            {loose.map((f) => (
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
  const [q, setQ] = useState('')
  const [onlyWarn, setOnlyWarn] = useState('')

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
    setForm(a ? { ...a } : { code: '', name: '', nickname: '', facebook: '', line_id: '', phone: '', id_card_ok: false, in_flow: false, note: '', active: true })
  }

  async function save() {
    if (!(form.name || '').trim()) return say('ใส่ชื่อช่างก่อนนะคะ', false)
    setSaving(true)
    const row = {
      name: form.name.trim(),
      code: (form.code || '').trim(),
      nickname: (form.nickname || '').trim(),
      facebook: (form.facebook || '').trim(),
      in_flow: !!form.in_flow,
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
    if (!window.confirm(`ลบช่าง ${artisanShort(a)} ใช่ไหม?`)) return
    const { error } = await supabase.from('artisans').delete().eq('id', a.id)
    if (error) return say('ลบไม่สำเร็จ: ' + error.message, false)
    setEditId(null)
    await refresh()
  }

  const needle = q.trim().toLowerCase()
  const list = sortArtisans(artisans)
    .filter((a) => showInactive || a.active)
    .filter((a) => !needle || artisanHay(a).includes(needle))
    .filter((a) => (onlyWarn === 'card' ? !a.id_card_ok : onlyWarn === 'flow' ? a.in_flow === false : true))
  const noCard = artisans.filter((a) => a.active && !a.id_card_ok).length
  const noFlow = artisans.filter((a) => a.active && a.in_flow === false).length

  const Form = (
    <div style={{ background: 'var(--petal)', borderRadius: 12, padding: 12, marginTop: 8 }}>
      <div className="jb-2col">
        <div className="jb-field">
          <label>ชื่อจริง</label>
          <input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="jb-field">
          <label>ชื่อในใบ / ชื่อเล่น</label>
          <input value={form.nickname || ''} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
        </div>
        <div className="jb-field">
          <label>ชื่อ Facebook</label>
          <input value={form.facebook || ''} onChange={(e) => setForm({ ...form, facebook: e.target.value })} />
        </div>
        <div className="jb-field">
          <label>รหัสช่าง (AAA ตามชีต)</label>
          <input inputMode="numeric" value={form.code || ''} onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="เช่น 066" />
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
        <input type="checkbox" style={{ width: 'auto' }} checked={!!form.in_flow} onChange={(e) => setForm({ ...form, in_flow: e.target.checked })} />
        มีใน FlowAccount แล้ว
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
        <div className="jb-chips" style={{ marginTop: 0 }}>
          <button className={'jb-chip' + (onlyWarn === '' ? ' on' : '')} onClick={() => setOnlyWarn('')}>ทั้งหมด</button>
          <button className={'jb-chip' + (onlyWarn === 'card' ? ' on' : '')} onClick={() => setOnlyWarn('card')}>ยังไม่มีบัตร {noCard}</button>
          <button className={'jb-chip' + (onlyWarn === 'flow' ? ' on' : '')} onClick={() => setOnlyWarn('flow')}>ยังไม่มีใน Flow {noFlow}</button>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 ค้นหา รหัส / ชื่อ / ชื่อในใบ / เฟส" style={{ marginBottom: 8 }} />
        {editId === 'new' && Form}

        {list.map((a) => {
          const s = stats[a.id] || { jobs: 0, open: 0, delays: 0, owe: 0 }
          return (
            <div key={a.id} className="jb-list-line" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="jb-row" style={{ justifyContent: 'space-between' }}>
                <span className="jb-name" style={{ fontSize: 16, opacity: a.active ? 1 : 0.55 }}>
                  {a.code && <span className="jb-code" style={{ marginRight: 6 }}>{a.code}</span>}
                  {artisanShort(a)}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => (editId === a.id ? setEditId(null) : open(a))}>แก้</button>
              </div>
              <div className="jb-small">
                {[a.facebook && 'FB ' + a.facebook, a.line_id && 'LINE ' + a.line_id, a.phone].filter(Boolean).join(' · ') || '—'}
              </div>
              <div>
                <button className={'tag ' + (a.id_card_ok ? 'gr' : 'rd')} style={{ border: 'none', cursor: 'pointer' }} onClick={() => toggleCard(a)} title="กดเพื่อสลับ">
                  {a.id_card_ok ? '✓ มีบัตร ปชช.' : 'ยังไม่มีบัตร ปชช.'}
                </button>
                {a.in_flow === false && <span className="tag am">ยังไม่มีใน Flow</span>}
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
