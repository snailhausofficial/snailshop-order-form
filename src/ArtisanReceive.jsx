import { useState, useEffect, useRef } from 'react'
import { supabase, genOrderCode } from './supabase'
import {
  JOB_BUCKET,
  SIZES,
  todayIso,
  ddmm,
  baht,
  statusIdx,
  jobTotals,
  groupItems,
  artisanShort,
  artisanLabel,
  artisanHay,
  sortArtisans,
  uploadJobFile,
  fileUrl,
  GroupsEditor,
  newGroup,
  nameGroups,
  rowsFromGroups,
  cleanItems,
} from './ArtisanJobs.jsx'
import { hasShipped, shipText } from './carriers.jsx'

/* =====================================================================
   รับ / ตรวจงานช่าง
   - ค้นช่าง → ใบงานค้าง → ฟอร์มตรวจ 5 หัวข้อ (พับได้)
   - ไม่มีใบสั่ง → รับงานใหม่ ระบบสร้าง "ใบงานย้อนหลัง" ให้
   - แก้ / ขาด = ค้างส่งตาม · ส่งตามมาแล้วกรอก "ส่งตามมาแล้ว __ ชุด" ยอดค้างลดเอง
   ===================================================================== */

export const ISSUE_KINDS = ['แก้', 'ขาด', 'ชำรุด', 'อื่นๆ']
const FIX_HOW = ['ส่งคืนให้แก้', 'ทำมาเพิ่มแทน']
const ISSUE_TONE = { แก้: 'am', ขาด: 'rd', ชำรุด: 'rd', อื่นๆ: 'gy' }

// ยอดค้างส่งตาม = แก้ + ขาด − ส่งตามมาแล้ว (ปิดยอดแล้ว = 0)
export function pendingOf(job) {
  if (!job || job.pending_closed) return 0
  const recs = job.job_receipts || []
  const owe = recs.flatMap((r) => r.receipt_issues || []).filter((x) => x.kind === 'แก้' || x.kind === 'ขาด').reduce((s, x) => s + (Number(x.qty) || 0), 0)
  const back = recs.reduce((s, r) => s + (Number(r.followup_qty) || 0), 0)
  return Math.max(0, owe - back)
}
export const issueText = (x) => `${x.kind} ${x.qty} ชุด${x.how ? ' · ' + x.how : ''}${x.note ? ' · ' + x.note : ''}`
export const IssueTag = ({ x }) => <span className={'tag ' + (ISSUE_TONE[x.kind] || 'gy')}>{x.kind} {x.qty}</span>

// ใบงานที่ยังต้องรับ/ตรวจ
export const needsReceive = (j) => (statusIdx(j.status) < 3 && j.status !== 'จ่ายเงินแล้ว') || pendingOf(j) > 0

/* ---------- หัวข้อพับได้ ---------- */
export function Section({ n, icon, title, summary, tone, done, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={'jb-sec' + (open ? ' open' : '')}>
      <button type="button" className="jb-sec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {n != null && <span className={'jb-sec-n' + (done ? ' done' : '')}>{done ? '✓' : n}</span>}
        <span className="jb-sec-title">
          {icon} {title}
        </span>
        {summary ? <span className={'jb-sec-sum' + (tone ? ' tag ' + tone : '')}>{summary}</span> : null}
        <span className="jb-sec-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && <div className="jb-sec-body">{children}</div>}
    </div>
  )
}

/* =====================================================================
   หน้าเลือก: ค้นช่าง → ใบงานที่ต้องรับ
   ===================================================================== */
export function ReceivePanel({ jobs, artisans, artById, onPickJob, onNewFor, onBack }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const open = jobs.filter(needsReceive)
  const byArtisan = (aid) => open.filter((j) => j.artisan_id === aid)

  // ยังไม่ค้น: แสดงงานที่น่าจะมาถึง (ช่างส่งแล้ว / ค้างส่งตาม) ก่อน
  const waiting = open
    .filter((j) => statusIdx(j.status) === 2 || pendingOf(j) > 0 || hasShipped(j))
    .sort((x, y) => (x.tracking_at || '').localeCompare(y.tracking_at || '') * -1)

  const found = needle ? sortArtisans(artisans.filter((a) => artisanHay(a).includes(needle))).slice(0, 12) : []

  const JobRow = ({ j }) => {
    const t = jobTotals(j)
    const p = pendingOf(j)
    return (
      <button className="jb-pick" onClick={() => onPickJob(j)}>
        <span className="jb-grow" style={{ textAlign: 'left' }}>
          {t.designs} ลาย · {t.qty} ชุด · {j.due_date ? 'ส่ง ' + ddmm(j.due_date) : 'ไม่ได้กำหนดวันส่ง'}
          {hasShipped(j) && <span className="jb-small"> · {shipText(j)}</span>}
        </span>
        {p > 0 ? <span className="tag am">ค้างส่งตาม {p}</span> : <span className="tag pk">{j.status}</span>}
        <span className="jb-go">›</span>
      </button>
    )
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={onBack}>← รายการใบงาน</button>
      <div className="jb-card">
        <h3><span>📥 รับ / ตรวจงาน</span></h3>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 พิมพ์ชื่อช่าง / ชื่อในใบ / ชื่อเฟส / รหัส"
          autoFocus
          style={{ fontSize: 17, padding: '13px 14px' }}
        />
        {needle && found.length === 0 && <p className="jb-muted" style={{ marginTop: 10 }}>ไม่เจอช่างชื่อนี้ — ไปเพิ่มที่ "รายชื่อช่าง" ก่อนนะคะ</p>}
      </div>

      {needle &&
        found.map((a) => {
          const list = byArtisan(a.id)
          return (
            <div key={a.id} className="jb-card">
              <div className="jb-name" style={{ fontSize: 17 }}>{artisanLabel(a)}</div>
              <p className="jb-small" style={{ margin: '4px 0 8px' }}>{list.length ? `ใบงานรอรับ ${list.length} ใบ — กดเพื่อตรวจ/รับ` : 'ไม่มีใบงานค้าง'}</p>
              {list.map((j) => <JobRow key={j.id} j={j} />)}
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={() => onNewFor(a)}>
                ➕ รับงานใหม่ (ไม่มีใบสั่ง)
              </button>
            </div>
          )
        })}

      {!needle && (
        <div className="jb-card">
          <h3><span>🚚 รอรับอยู่ ({waiting.length})</span></h3>
          {waiting.length === 0 && <p className="jb-muted">ตอนนี้ยังไม่มีงานที่ช่างแจ้งส่ง — ค้นชื่อช่างด้านบนได้เลย</p>}
          {waiting.map((j) => (
            <div key={j.id} style={{ marginBottom: 6 }}>
              <div className="jb-small" style={{ color: 'var(--plum)' }}>{artisanShort(artById[j.artisan_id])}</div>
              <JobRow j={j} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* =====================================================================
   ฟอร์มตรวจ/รับ (มีใบงาน หรือ รับงานใหม่ไม่มีใบสั่ง)
   ===================================================================== */
export function ReceiveForm({ job, artisan, say, onDone, onCancel }) {
  const isNew = !job
  const items = job ? [...(job.job_items || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id) : []
  const pending = pendingOf(job)
  const remainOf = (i) => Math.max(0, (Number(i.qty) || 0) - (Number(i.qty_received) || 0))
  const remainTotal = items.reduce((s, i) => s + remainOf(i), 0)

  const [date, setDate] = useState(todayIso())
  const [recv, setRecv] = useState(() => Object.fromEntries(items.map((i) => [i.id, String(remainOf(i) || '')])))
  const [followup, setFollowup] = useState(pending > 0 && remainTotal === 0 ? String(pending) : '')
  const [extra, setExtra] = useState('') // ส่งตามที่ไม่ได้ลงรายลาย
  const [groups, setGroups] = useState(() => [newGroup()])
  const [issues, setIssues] = useState([])
  const [photos, setPhotos] = useState([])
  const [note, setNote] = useState('')
  const [shipFee, setShipFee] = useState(String(artisan?.ship_fee ?? 50))
  const [paidOff, setPaidOff] = useState(false)
  const [saving, setSaving] = useState(false)
  const photosRef = useRef(photos)
  photosRef.current = photos
  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), [])

  const num = (v) => v.replace(/\D/g, '')
  const totalRecv = isNew
    ? rowsFromGroups(groups).reduce((s, r) => s + (Number(r.qty) || 0), 0)
    : items.reduce((s, i) => s + (Number(recv[i.id]) || 0), 0) + (Number(extra) || 0)

  const addIssue = (kind) => setIssues([...issues, { k: Math.random(), kind, qty: '', how: kind === 'แก้' ? FIX_HOW[0] : '', note: '' }])
  const updIssue = (k, patch) => setIssues(issues.map((x) => (x.k === k ? { ...x, ...patch } : x)))
  const delIssue = (k) => setIssues(issues.filter((x) => x.k !== k))
  const addPhotos = (e) => {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    setPhotos([...photos, ...list.map((file) => ({ file, url: URL.createObjectURL(file) }))])
  }
  const delPhoto = (i) => {
    URL.revokeObjectURL(photos[i].url)
    setPhotos(photos.filter((_, n) => n !== i))
  }

  async function save() {
    if (!date) return say('ใส่วันที่รับก่อนนะคะ', false)
    if (totalRecv <= 0 && !issues.length) return say('ใส่จำนวนที่รับ หรือรายการแก้/ขาดอย่างน้อย 1 อย่าง', false)
    const fu = Math.min(Number(followup) || 0, totalRecv)
    if ((Number(followup) || 0) > totalRecv) return say(`"ส่งตามมาแล้ว" ต้องไม่เกินจำนวนที่รับรอบนี้ (${totalRecv} ชุด)`, false)
    const cleanIssues = issues.filter((x) => Number(x.qty) > 0 || x.note.trim())
    const issTxt = cleanIssues.filter((x) => Number(x.qty) > 0).map((x) => `${x.kind} ${x.qty}`).join(' · ')
    if (!window.confirm(`บันทึกการรับของ ${artisanShort(artisan)}\nวันที่ ${ddmm(date)} · รับ ${totalRecv} ชุด${fu ? ` (ส่งตาม ${fu})` : ''}${issTxt ? '\n' + issTxt : ''}${isNew ? `\n(สร้างใบงานย้อนหลังให้ · ค่าส่ง ${shipFee || 0} บาท${paidOff ? ' · จ่ายแล้วนอกระบบ' : ''})` : ''}\nใช่ไหม?`)) return
    setSaving(true)
    try {
      const must = ({ error, data }) => {
        if (error) throw error
        return data
      }
      const { data: u } = await supabase.auth.getUser()
      const by = u?.user?.email || ''
      let jobId = job?.id
      let code = job?.code
      let detail = []

      if (isNew) {
        // ไม่มีใบสั่ง → สร้างใบงานย้อนหลัง
        const rows = rowsFromGroups(groups)
        const created = must(
          await supabase
            .from('artisan_jobs')
            .insert({ code: genOrderCode(), artisan_id: artisan.id, order_date: date, due_date: null, status: paidOff ? 'จ่ายเงินแล้ว' : 'รับ/ตรวจแล้ว', pay_term: 'จ่ายทีหลัง', backdated: true, ship_fee: Number(shipFee) || 0, paid_offsystem: paidOff, brief: '', internal_note: 'ใบงานย้อนหลัง (สร้างตอนรับของ)' })
            .select()
            .single()
        )
        jobId = created.id
        code = created.code
        const its = cleanItems(rows, jobId).map((r) => ({ ...r, qty_received: r.qty }))
        must(await supabase.from('job_items').insert(its))
        detail = its.map((r) => ({ design: r.design, size: r.size, qty: r.qty }))
      } else {
        // บวกยอดรับจริงเข้าแต่ละแถว (ไม่เกินจำนวนที่สั่ง)
        for (const i of items) {
          const n = Number(recv[i.id]) || 0
          if (!n) continue
          detail.push({ design: i.design, size: i.size, qty: n })
          const next = Math.min(Number(i.qty) || 0, (Number(i.qty_received) || 0) + n)
          must(await supabase.from('job_items').update({ qty_received: next }).eq('id', i.id))
        }
        if (Number(extra) > 0) detail.push({ design: 'ส่งตาม (ไม่ระบุลาย)', size: '', qty: Number(extra) })
        if (statusIdx(job.status) < 3) must(await supabase.from('artisan_jobs').update({ status: 'รับ/ตรวจแล้ว' }).eq('id', jobId))
      }

      const rec = must(
        await supabase
          .from('job_receipts')
          .insert({ job_id: jobId, received_on: date, qty_total: totalRecv, followup_qty: fu, detail, note: note.trim(), received_by: by })
          .select()
          .single()
      )
      if (cleanIssues.length)
        must(
          await supabase
            .from('receipt_issues')
            .insert(cleanIssues.map((x) => ({ receipt_id: rec.id, job_id: jobId, kind: x.kind, qty: Number(x.qty) || 0, how: x.kind === 'แก้' ? x.how : '', note: x.note.trim() })))
        )
      // ชำรุด → บวกเข้าช่องชำรุดของใบงาน (แถวแรก) ไว้ดูยอดรวม
      const dmg = cleanIssues.filter((x) => x.kind === 'ชำรุด').reduce((s, x) => s + (Number(x.qty) || 0), 0)
      if (dmg && !isNew && items[0]) must(await supabase.from('job_items').update({ qty_damaged: (Number(items[0].qty_damaged) || 0) + dmg }).eq('id', items[0].id))

      let failed = 0
      for (const p of photos) {
        try {
          const path = await uploadJobFile(code, p.file)
          must(await supabase.from('job_files').insert({ job_id: jobId, path, kind: 'รูปงาน', uploaded_by: 'ร้าน', design: '', receipt_id: rec.id }))
        } catch {
          failed++
        }
      }
      say(failed ? `✅ บันทึกการรับแล้ว แต่รูปอัปไม่ได้ ${failed} รูป` : `✅ บันทึกการรับ ${totalRecv} ชุดแล้ว`, !failed)
      await onDone(jobId)
    } catch (e) {
      say('บันทึกไม่สำเร็จ: ' + e.message, false)
    } finally {
      setSaving(false)
    }
  }

  const issueSum = issues.filter((x) => Number(x.qty) > 0).map((x) => `${x.kind} ${x.qty}`).join(' · ')
  const t = job ? jobTotals(job) : null

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={onCancel}>← ยกเลิก</button>
      <div className="jb-card" style={{ paddingBottom: 8 }}>
        <div className="jb-name" style={{ fontSize: 19 }}>📥 {artisanShort(artisan)}</div>
        <p className="jb-small" style={{ marginTop: 2 }}>
          {isNew ? 'รับงานใหม่ (ไม่มีใบสั่ง) — ระบบจะสร้างใบงานย้อนหลังให้' : `ใบงาน ${job.code} · สั่ง ${t.qty} ชุด · รับแล้ว ${t.recvQty} ชุด`}
        </p>
        {pending > 0 && <p className="tag am" style={{ marginTop: 6 }}>ค้างส่งตาม {pending} ชุด</p>}
        <div className="jb-chips" style={{ margin: '10px 0 0' }}>
          <span className="tag gr">1 วันที่ {ddmm(date)}</span>
          <span className={'tag ' + (totalRecv > 0 ? 'gr' : 'gy')}>2 รับ {totalRecv} ชุด</span>
          <span className={'tag ' + (issueSum ? 'am' : 'gy')}>3 {issueSum || 'แก้/ขาด'}</span>
          <span className={'tag ' + (photos.length ? 'gr' : 'gy')}>4 รูป {photos.length}</span>
          <span className={'tag ' + (note.trim() ? 'gr' : 'gy')}>5 หมายเหตุ</span>
        </div>
      </div>

      <Section n={1} icon="📅" title="วันที่รับ" summary={ddmm(date)} done={!!date}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Section>

      <Section n={2} icon="📦" title="จำนวนที่รับ" summary={`${totalRecv} ชุด`} done={totalRecv > 0} defaultOpen>
        {isNew ? (
          <>
            <p className="jb-small" style={{ marginBottom: 8 }}>ใส่ลาย / ไซส์ / จำนวนที่ได้รับ (ราคาไม่บังคับ — ใส่ถ้าซื้อเลย)</p>
            <GroupsEditor groups={groups} setGroups={setGroups} />
            <div className="jb-row" style={{ marginTop: 8 }}>
              <span className="jb-small">🚚 ค่าส่ง</span>
              <input inputMode="decimal" style={{ width: 80 }} value={shipFee} onChange={(e) => setShipFee(e.target.value.replace(/[^\d.]/g, ''))} />
              <span className="jb-small">บาท</span>
            </div>
            <label className="jb-paidoff">
              <input type="checkbox" checked={paidOff} onChange={(e) => setPaidOff(e.target.checked)} />
              <span>✔ จ่ายแล้ว (นอกระบบ) — ไม่ต้องแนบสลิป ปิดใบงานเป็น "จ่ายเงินแล้ว" เลย</span>
            </label>
          </>
        ) : (
          <>
            {remainTotal > 0 ? (
              <p className="jb-small" style={{ marginBottom: 8 }}>เติมตามที่ยังไม่ได้รับให้แล้ว — แก้เฉพาะช่องที่ไม่ตรง</p>
            ) : (
              <p className="jb-small" style={{ marginBottom: 8 }}>รับครบตามที่สั่งแล้ว — รอบนี้น่าจะเป็นของส่งตาม</p>
            )}
            {groupItems(items).map((g, n) => (
              <div key={n} className="jb-dedit" style={{ padding: 8 }}>
                <div className="jb-dtitle" style={{ fontSize: 15 }}>{g.design}</div>
                <div className="jb-sizes">
                  {SIZES.map((sz) => {
                    const it = g.sizes.find((x) => x.size === sz)
                    if (!it) return <div key={sz} className="jb-size"><span className="jb-sz" style={{ opacity: 0.35 }}>{sz}</span><span className="jb-small" style={{ textAlign: 'center' }}>—</span></div>
                    return (
                      <div key={sz} className="jb-size">
                        <span className="jb-sz">{sz}</span>
                        <input inputMode="numeric" value={recv[it.id] ?? ''} onChange={(e) => setRecv({ ...recv, [it.id]: num(e.target.value) })} placeholder="0" />
                        <span className="jb-small" style={{ textAlign: 'center' }}>สั่ง {it.qty} · รับแล้ว {it.qty_received ?? 0}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            {(pending > 0 || remainTotal === 0) && (
              <div className="jb-row" style={{ marginTop: 6 }}>
                <span className="jb-small">ของส่งตามที่ไม่ได้ลงรายลาย</span>
                <input inputMode="numeric" style={{ width: 80 }} value={extra} onChange={(e) => setExtra(num(e.target.value))} placeholder="0" />
                <span className="jb-small">ชุด</span>
              </div>
            )}
          </>
        )}
        {(pending > 0 || (!isNew && remainTotal === 0)) && (
          <div className="jb-row" style={{ marginTop: 10, background: '#FDF0D8', borderRadius: 10, padding: 8 }}>
            <span style={{ fontSize: 14 }}>🔁 ในนี้เป็นของ<b style={{ fontWeight: 400 }}>ส่งตาม/แก้กลับมา</b></span>
            <input inputMode="numeric" style={{ width: 70 }} value={followup} onChange={(e) => setFollowup(num(e.target.value))} placeholder="0" />
            <span className="jb-small">ชุด{pending > 0 ? ` (ค้าง ${pending})` : ''}</span>
          </div>
        )}
      </Section>

      <Section n={3} icon="🛠" title="แก้ / ขาด / ชำรุด" summary={issueSum || 'ไม่มี'} tone={issueSum ? 'am' : ''} done={issues.length > 0} defaultOpen>
        <div className="jb-chips" style={{ margin: '0 0 8px' }}>
          {ISSUE_KINDS.map((k) => (
            <button key={k} type="button" className="jb-chip" onClick={() => addIssue(k)}>+ {k}</button>
          ))}
        </div>
        {issues.length === 0 && <p className="jb-small">ไม่มีปัญหา ข้ามหัวข้อนี้ได้เลย · แก้/ขาด จะนับเป็นยอดค้างส่งตาม</p>}
        {issues.map((x) => (
          <div key={x.k} className="jb-issue">
            <div className="jb-row">
              <span className={'tag ' + ISSUE_TONE[x.kind]} style={{ margin: 0 }}>{x.kind}</span>
              <input inputMode="numeric" style={{ width: 70 }} value={x.qty} onChange={(e) => updIssue(x.k, { qty: num(e.target.value) })} placeholder="0" autoFocus />
              <span className="jb-small">ชุด</span>
              <span className="jb-grow" />
              <button className="icon-btn" title="ลบ" onClick={() => delIssue(x.k)}>🗑</button>
            </div>
            {x.kind === 'แก้' && (
              <div className="jb-chips" style={{ margin: '6px 0 0' }}>
                {FIX_HOW.map((h) => (
                  <button key={h} type="button" className={'jb-chip' + (x.how === h ? ' on' : '')} onClick={() => updIssue(x.k, { how: h })}>{h}</button>
                ))}
              </div>
            )}
            <input style={{ marginTop: 6 }} value={x.note} onChange={(e) => updIssue(x.k, { note: e.target.value })} placeholder={x.kind === 'ขาด' ? 'เช่น ดอกไม้ขาว M · ช่างส่งตาม' : 'เช่น สีไม่ตรง / เล็บบิ่น'} />
          </div>
        ))}
      </Section>

      <Section n={4} icon="📷" title="รูป" summary={photos.length ? `${photos.length} รูป` : ''} done={photos.length > 0}>
        <div className="jb-row" style={{ alignItems: 'flex-start' }}>
          {photos.map((p, i) => (
            <div key={p.url} className="jb-file" style={{ width: 72 }}>
              <img src={p.url} alt="รูปรับของ" />
              <button className="x" title="เอาออก" onClick={() => delPhoto(i)}>✕</button>
            </div>
          ))}
          <label className="jb-addphoto" style={{ width: 72, height: 72 }}>
            📷<span>เพิ่มรูป</span>
            <input type="file" accept="image/*" multiple onChange={addPhotos} />
          </label>
        </div>
        <p className="jb-small" style={{ marginTop: 6 }}>รูปของที่รับ / ชิ้นที่ต้องแก้ — ช่างเห็นในลิงก์ช่าง</p>
      </Section>

      <Section n={5} icon="📝" title="หมายเหตุ" summary={note.trim() ? 'มี' : ''} done={!!note.trim()}>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="ไม่บังคับ — ช่างเห็นด้วย" style={{ minHeight: 60 }} />
      </Section>

      <button className="btn btn-rose" style={{ width: '100%', marginTop: 4 }} disabled={saving} onClick={save}>
        {saving ? 'กำลังบันทึก...' : `💾 บันทึกการรับ ${totalRecv} ชุด`}
      </button>
    </>
  )
}

/* =====================================================================
   ผลตรวจรับในหน้าใบงาน (หลังร้าน) / หน้าช่าง
   ===================================================================== */
export function ReceiptList({ receipts, files = [], showBy }) {
  const list = [...(receipts || [])].sort((a, b) => (a.received_on || '').localeCompare(b.received_on || '') || (a.id ?? 0) - (b.id ?? 0))
  if (!list.length) return <p className="jb-muted">ยังไม่ได้รับของ</p>
  return list.map((r, n) => {
    const iss = r.receipt_issues || r.issues || []
    const ph = files.filter((f) => f.receipt_id === r.id)
    return (
      <div key={r.id ?? n} className="jb-receipt">
        <div className="jb-row" style={{ justifyContent: 'space-between' }}>
          <b style={{ fontWeight: 400, color: 'var(--plum)' }}>รอบ {n + 1} · {ddmm(r.received_on)}</b>
          <span>รับ <b style={{ color: 'var(--pink-deep)', fontWeight: 400 }}>{r.qty_total}</b> ชุด</span>
        </div>
        {r.followup_qty > 0 && <div className="jb-small">🔁 เป็นของส่งตาม/แก้กลับมา {r.followup_qty} ชุด</div>}
        {iss.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {iss.map((x, k) => (
              <div key={k} className="jb-small" style={{ fontSize: 13 }}>
                <IssueTag x={x} /> {[x.how, x.note].filter(Boolean).join(' · ')}
              </div>
            ))}
          </div>
        )}
        {r.note && <div style={{ fontSize: 13, marginTop: 4 }}>📝 {r.note}</div>}
        {ph.length > 0 && (
          <div className="jb-row" style={{ marginTop: 6, gap: 6 }}>
            {ph.map((f, k) => (
              <a key={k} href={fileUrl(f.path)} target="_blank" rel="noreferrer" className="jb-mini" style={{ width: 48, height: 48 }}>
                <img src={fileUrl(f.path)} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        )}
        {showBy && r.received_by && <div className="jb-small" style={{ marginTop: 4 }}>รับโดย {r.received_by}</div>}
      </div>
    )
  })
}

/* =====================================================================
   สรุปรายวัน (เหมือนหน้ากระดาษ: วันที่ / ช่าง / จำนวนชุด / หมายเหตุ)
   ===================================================================== */
export function DailySummary({ jobs, artById, onOpen, onBack }) {
  const [date, setDate] = useState(todayIso())
  const shift = (n) => {
    const [y, m, d] = date.split('-').map(Number)
    const x = new Date(y, m - 1, d + n)
    setDate(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`)
  }
  const rows = jobs
    .flatMap((j) => (j.job_receipts || []).filter((r) => r.received_on === date).map((r) => ({ r, j })))
    .sort((x, y) => (x.r.created_at || '').localeCompare(y.r.created_at || ''))
  const total = rows.reduce((s, x) => s + (Number(x.r.qty_total) || 0), 0)
  const byKind = {}
  rows.forEach(({ r }) => (r.receipt_issues || []).forEach((x) => (byKind[x.kind] = (byKind[x.kind] || 0) + (Number(x.qty) || 0))))
  const artisansN = new Set(rows.map((x) => x.j.artisan_id)).size
  const ym = date.slice(0, 7)
  const mRecs = jobs.flatMap((j) => (j.job_receipts || []).filter((r) => (r.received_on || '').slice(0, 7) === ym))
  const mQty = mRecs.reduce((s, r) => s + (Number(r.qty_total) || 0), 0)
  const mKind = {}
  mRecs.forEach((r) => (r.receipt_issues || []).forEach((x) => (mKind[x.kind] = (mKind[x.kind] || 0) + (Number(x.qty) || 0))))
  const mPaid = jobs.flatMap((j) => j.job_payments || []).filter((p) => (p.paid_on || '').slice(0, 7) === ym).reduce((s, p) => s + (Number(p.amount) || 0), 0)

  return (
    <>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={onBack}>← รายการใบงาน</button>
      <div className="jb-card">
        <h3><span>📅 สรุปรับงานรายวัน</span></h3>
        <div className="jb-row">
          <button className="btn btn-ghost btn-sm" onClick={() => shift(-1)}>‹</button>
          <input type="date" className="jb-grow" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn btn-ghost btn-sm" onClick={() => shift(1)}>›</button>
        </div>
        <div className="jb-kv" style={{ marginTop: 10 }}>
          <span>{artisansN} ช่าง · {rows.length} รายการ</span>
          <b>รวม {total} ชุด</b>
        </div>
        {Object.keys(byKind).length > 0 && (
          <div>
            {Object.entries(byKind).map(([k, v]) => <IssueTag key={k} x={{ kind: k, qty: v }} />)}
          </div>
        )}
      </div>

      <div className="jb-card" style={{ background: 'var(--petal)' }}>
        <div className="jb-kv"><span>ทั้งเดือน {ym.slice(5, 7)}/{ym.slice(0, 4)} · {mRecs.length} รอบรับ</span><b>รับ {mQty} ชุด</b></div>
        <div className="jb-kv"><span>จ่ายช่างทั้งเดือน (มีสลิป)</span><b>{baht(mPaid)} ฿</b></div>
        <div>{Object.entries(mKind).map(([k, v]) => <IssueTag key={k} x={{ kind: k, qty: v }} />)}</div>
      </div>

      {rows.length === 0 && <div className="jb-card"><p className="jb-muted">วันนี้ยังไม่มีการรับงาน</p></div>}
      {rows.map(({ r, j }) => {
        const a = artById[j.artisan_id]
        const ph = (j.job_files || []).filter((f) => f.receipt_id === r.id).length
        return (
          <button key={r.id} className="jb-job" onClick={() => onOpen(j.id)}>
            <div className="jb-job-top">
              <span className="jb-name">{artisanShort(a)}</span>
              <span style={{ fontFamily: 'Itim', color: 'var(--pink-deep)', fontSize: 17 }}>{r.qty_total} ชุด</span>
            </div>
            <div className="jb-small">
              {j.backdated ? 'ไม่มีใบสั่ง (ย้อนหลัง)' : 'ใบงาน ' + j.code}
              {r.followup_qty > 0 ? ` · ส่งตาม ${r.followup_qty}` : ''}
              {ph ? ` · 📷 ${ph}` : ''}
            </div>
            <div>{(r.receipt_issues || []).map((x, k) => <IssueTag key={k} x={x} />)}</div>
            {r.note && <div style={{ fontSize: 13, marginTop: 2 }}>📝 {r.note}</div>}
          </button>
        )
      })}
    </>
  )
}
