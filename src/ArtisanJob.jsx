import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from './supabase'
import { JOB_STATUSES, jobTotals, ddmm, baht, statusIdx, fileUrl, uploadJobFile, DesignCards, looseFiles, dueText, relDue } from './ArtisanJobs.jsx'
import { CARRIERS, guessCarrier, hasShipped, shipText, TrackLink } from './carriers.jsx'
import './jobs.css'

/* =====================================================================
   หน้าช่าง: /job/{code} — ดูใบสั่งงานของตัวเอง (ไม่ต้องล็อกอิน)
   อ่านผ่าน rpc get_job_by_code (ได้ทีละ 1 ใบ เฉพาะช่องที่ช่างควรเห็น)
   เขียนได้แค่: เลขพัสดุ + ขนส่ง (submit_job_tracking) และรูปส่งงาน (add_job_photo)
   ล็อกเมื่อร้านกด "รับ/ตรวจแล้ว"
   ===================================================================== */

const LOGO = '/logo.png'
const isPdf = (p) => /\.pdf$/i.test(p || '')

export default function ArtisanJob() {
  const { code } = useParams()
  const [job, setJob] = useState(undefined) // undefined = กำลังโหลด, null = ไม่พบ
  const [tk, setTk] = useState('')
  const [carrier, setCarrier] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    document.title = 'ใบสั่งงาน — Snail Shop'
  }, [])

  async function load() {
    if (!supabase) return setJob(null)
    const { data, error } = await supabase.rpc('get_job_by_code', { p_code: code })
    const j = error || !data ? null : data
    setJob(j)
    if (j) {
      setTk(j.tracking || '')
      setCarrier(j.tracking_carrier || guessCarrier(j.tracking))
    }
  }

  useEffect(() => {
    load()
  }, [code]) // eslint-disable-line

  function say(text, ok = true, where = 'track') {
    setMsg({ text, ok, where })
  }
  const Msg = ({ where }) =>
    msg && msg.where === where ? (
      <div className={'jb-toast' + (msg.ok ? '' : ' err')} style={{ position: 'static', marginTop: 10, marginBottom: 0 }} onClick={() => setMsg(null)}>
        {msg.text}
      </div>
    ) : null

  async function sendTracking() {
    const c = carrier || guessCarrier(tk)
    if (!c) return say('เลือกขนส่งก่อนนะคะ', false)
    if (c !== 'มาส่งเอง' && !tk.trim()) return say('ใส่เลขพัสดุก่อนนะคะ', false)
    setBusy('track')
    const { data, error } = await supabase.rpc('submit_job_tracking', { p_code: code, p_tracking: tk, p_carrier: c })
    setBusy('')
    if (error || !data?.ok) return say('ส่งไม่สำเร็จ: ' + (data?.error || error?.message || 'ลองใหม่อีกครั้ง'), false)
    say('✅ แจ้งส่งของแล้ว ขอบคุณค่ะ')
    load()
  }

  async function uploadPhotos(e) {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    if (!list.length) return
    setBusy('photo')
    let ok = 0
    let err = ''
    for (const f of list) {
      try {
        const path = await uploadJobFile(code, f)
        const { data, error } = await supabase.rpc('add_job_photo', { p_code: code, p_path: path })
        if (error || !data?.ok) throw new Error(data?.error || error?.message)
        ok++
      } catch (x) {
        err = x.message || 'อัปไม่สำเร็จ'
      }
    }
    setBusy('')
    if (ok) say(`✅ อัปรูปแล้ว ${ok} รูป${err ? ' (บางรูปไม่สำเร็จ: ' + err + ')' : ''}`, !err, 'photo')
    else say('อัปรูปไม่สำเร็จ: ' + err, false, 'photo')
    load()
  }

  if (job === undefined) {
    return (
      <div className="ord-wrap">
        <div className="ord-loading">
          <img src={LOGO} alt="Snail Shop" style={{ width: 160, display: 'block', margin: '0 auto 8px' }} />
          กำลังโหลด...
        </div>
      </div>
    )
  }

  if (job === null) {
    return (
      <div className="ord-wrap">
        <div className="ord-card ord-notfound">
          <img src={LOGO} alt="Snail Shop" style={{ width: 180, maxWidth: '70%', display: 'block', margin: '0 auto 10px' }} />
          <h2>ไม่พบใบงานนี้</h2>
          <p>เลขที่ {code} อาจไม่ถูกต้อง หรือใบงานถูกยกเลิกแล้ว — สอบถามร้านได้เลยค่ะ</p>
        </div>
      </div>
    )
  }

  // ให้หน้าตาข้อมูลเหมือนฝั่งหลังร้าน จะได้ใช้ตัวคำนวณ/การ์ดเดียวกัน
  const j = { ...job, job_items: job.items || [], job_payments: job.payments || [] }
  const t = jobTotals(j)
  const step = statusIdx(job.status)
  const locked = step >= 3 // ร้านรับของแล้ว
  const delays = job.delays || []
  const files = job.files || []
  const loose = looseFiles(j.job_items, files)
  const looseBrief = loose.filter((f) => f.uploaded_by !== 'ช่าง' && f.kind === 'บรีฟ')
  const myPhotos = files.filter((f) => f.uploaded_by === 'ช่าง')
  const otherWork = loose.filter((f) => f.uploaded_by !== 'ช่าง' && f.kind !== 'บรีฟ')

  return (
    <div className="ord-wrap">
      <div className="ord-top">
        <img src={LOGO} alt="Snail Shop" style={{ height: 56, maxWidth: '80%', display: 'block', margin: '0 auto' }} />
        <span className="ord-sub">ใบสั่งงานช่าง</span>
      </div>

      <div className="ord-card">
        <div className="ord-eyebrow">ใบสั่งงาน</div>
        <h1 className="ord-no" style={{ marginBottom: 6 }}>
          {/^ช่าง/.test(job.artisan_name || '') ? '' : 'ช่าง '}<b>{job.artisan_name}</b>
        </h1>
        <div className="jb-code" style={{ marginBottom: 18 }}>เลขที่ {job.code}</div>

        {/* แถบสถานะ 5 ขั้น */}
        <div className="tracker">
          {JOB_STATUSES.map((s, i) => {
            const done = i < step
            const now = i === step
            return (
              <div key={s} className={'step ' + (done ? 'done' : now ? 'now' : '')}>
                <div className="dot">{done ? '✓' : i + 1}</div>
                <div className="step-label" style={{ fontSize: 11 }}>{s}</div>
                {i < JOB_STATUSES.length - 1 && <div className={'bar ' + (i < step ? 'done' : '')} />}
              </div>
            )
          })}
        </div>
        <div className="status-now">สถานะตอนนี้: <b>{job.status}</b></div>

        {/* กำหนดส่ง */}
        <div className="ord-sec">
          <div className="ord-sec-title">📅 กำหนดส่ง</div>
          <div className="ord-line">
            สั่งงาน {ddmm(job.order_date)} ·{' '}
            {job.due_date ? (
              <>ส่งภายใน <b style={{ color: 'var(--pink-deep)' }}>{ddmm(job.due_date)}</b>{step < 2 && <span className="jb-small"> ({relDue(job.due_date)})</span>}</>
            ) : (
              <b style={{ color: 'var(--pink-deep)' }}>{dueText(null)}</b>
            )}
          </div>
          {delays.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {delays.map((d) => (
                <div key={d.seq} className="jb-small" style={{ fontSize: 13 }}>
                  🔁 เลื่อนครั้งที่ {d.seq}: {dueText(d.old_date)} → {dueText(d.new_date)}{d.reason ? ` (${d.reason})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* รายการ (การ์ดต่อลาย + รูป ref) */}
        <div className="ord-sec">
          <div className="ord-sec-title">🎨 รายการ</div>
          <DesignCards items={j.job_items} files={files.filter((f) => f.uploaded_by !== 'ช่าง')} />
          <div className="jb-total"><span>รวม {t.qty} ชุด</span><span>{baht(t.amount)} ฿</span></div>
          {t.anyRecv && (
            <div className="ord-line" style={{ fontSize: 13 }}>
              ร้านรับของแล้ว {t.recvQty} ชุด{t.damaged ? ` · ชำรุด ${t.damaged} ชุด` : ''}
            </div>
          )}
        </div>

        {/* บรีฟ */}
        {(job.brief || looseBrief.length > 0) && (
          <div className="ord-sec">
            <div className="ord-sec-title">📝 บรีฟ / หมายเหตุ</div>
            {job.brief && <div className="ord-line" style={{ whiteSpace: 'pre-wrap' }}>{job.brief}</div>}
            {looseBrief.length > 0 && <Gallery files={looseBrief} />}
          </div>
        )}

        {/* การจ่ายเงิน */}
        <div className="ord-sec">
          <div className="ord-sec-title">💸 การจ่ายเงิน</div>
          {j.job_payments.length === 0 && <div className="ord-line jb-muted">ยังไม่มีการโอน</div>}
          {j.job_payments.map((p, k) => (
            <div key={k} className="jb-list-line">
              <span>
                {p.kind} · {ddmm(p.paid_on)}{' '}
                {p.slip_path && (
                  <a className="jb-link" href={fileUrl(p.slip_path)} target="_blank" rel="noreferrer">🧾 ดูสลิป</a>
                )}
              </span>
              <span>{baht(p.amount)} ฿</span>
            </div>
          ))}
          <div className="jb-kv" style={{ borderTop: '1px solid var(--line)', marginTop: 4, paddingTop: 8 }}>
            <span>ยอด {baht(t.amount)} · โอนแล้ว {baht(t.paid)}</span>
            <b>คงเหลือ {baht(Math.max(0, t.balance))} ฿</b>
          </div>
        </div>

        {/* ส่งของ — ช่างกรอกเอง */}
        <div className="ord-sec">
          <div className="ord-sec-title">🚚 ส่งของมาที่ร้าน</div>
          {hasShipped(job) && (
            <div className="ord-line" style={{ marginBottom: 6 }}>
              แจ้งแล้ว: <b>{shipText(job)}</b>
              {job.tracking_at && <span className="jb-small"> · {ddmm(job.tracking_at.slice(0, 10))}</span>}
              <div style={{ marginTop: 6 }}>
                <TrackLink tk={job.tracking} carrier={job.tracking_carrier} className="jb-link" onCopied={() => say('📋 คัดลอกเลขพัสดุแล้ว ไปวางในเว็บขนส่งได้เลย')} />
              </div>
            </div>
          )}

          {locked ? (
            <div className="ord-line jb-muted">ร้านรับของแล้ว — แก้ไขไม่ได้แล้วค่ะ</div>
          ) : (
            <div style={{ background: 'var(--petal)', borderRadius: 12, padding: 12 }}>
              <label style={{ marginBottom: 6 }}>{hasShipped(job) ? 'แก้ข้อมูลการส่ง' : 'ส่งของแล้ว? เลือกขนส่ง + ใส่เลขพัสดุ'}</label>
              <div className="jb-chips" style={{ margin: '0 0 8px' }}>
                {CARRIERS.map((c) => (
                  <button key={c} type="button" className={'jb-chip' + (carrier === c ? ' on' : '')} onClick={() => setCarrier(c)}>
                    {c}
                  </button>
                ))}
              </div>
              {carrier !== 'มาส่งเอง' && (
                <input
                  value={tk}
                  onChange={(e) => {
                    setTk(e.target.value)
                    if (!carrier) setCarrier(guessCarrier(e.target.value))
                  }}
                  placeholder="เลขพัสดุ เช่น TH27229622KU7F"
                  autoCapitalize="characters"
                  style={{ marginBottom: 8, background: '#fff' }}
                />
              )}
              <button className="btn btn-primary" style={{ background: 'var(--pink-deep)' }} disabled={busy === 'track'} onClick={sendTracking}>
                {busy === 'track' ? 'กำลังส่ง...' : carrier === 'มาส่งเอง' ? '✅ แจ้งว่ามาส่งเอง' : '✅ แจ้งเลขพัสดุ'}
              </button>
            </div>
          )}
          <Msg where="track" />
        </div>

        {/* รูปส่งงาน — ช่างอัปเอง */}
        <div className="ord-sec">
          <div className="ord-sec-title">📷 รูปส่งงาน</div>
          {myPhotos.length > 0 ? <Gallery files={myPhotos} /> : <div className="ord-line jb-muted">ยังไม่มีรูป</div>}
          {!locked && (
            <label className="btn btn-ghost jb-upload" style={{ width: '100%', marginTop: 10 }}>
              {busy === 'photo' ? 'กำลังอัป...' : '📷 แนบรูปส่งงาน'}
              <input type="file" accept="image/*" multiple disabled={!!busy} onChange={uploadPhotos} />
            </label>
          )}
          <Msg where="photo" />
          {otherWork.length > 0 && (
            <>
              <div className="jb-small" style={{ marginTop: 10 }}>รูปจากร้าน</div>
              <Gallery files={otherWork} />
            </>
          )}
        </div>

      </div>

      <div className="ord-foot">Snail Shop · เล็บปลอม Handmade</div>
    </div>
  )
}

function Gallery({ files }) {
  return (
    <div className="jb-files" style={{ marginTop: 8 }}>
      {files.map((f, k) => (
        <a key={k} className="jb-file" href={fileUrl(f.path)} target="_blank" rel="noreferrer">
          {isPdf(f.path) ? <span style={{ fontSize: 30 }}>📄</span> : <img src={fileUrl(f.path)} alt={f.kind} loading="lazy" />}
        </a>
      ))}
    </div>
  )
}
