import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from './supabase'
import { carrierOf, trackUrlOf } from './SnailOrderForm.jsx'
import { JOB_STATUSES, jobTotals, ddmm, baht, statusIdx, fileUrl } from './ArtisanJobs.jsx'
import './jobs.css'

/* =====================================================================
   หน้าช่าง: /job/{code} — ดูใบสั่งงานของตัวเอง (ไม่ต้องล็อกอิน)
   อ่านผ่าน rpc get_job_by_code เท่านั้น (ได้ทีละ 1 ใบ เฉพาะช่องที่ช่างควรเห็น)
   ===================================================================== */

const LOGO = '/logo.png'
const isPdf = (p) => /\.pdf$/i.test(p || '')

export default function ArtisanJob() {
  const { code } = useParams()
  const [job, setJob] = useState(undefined) // undefined = กำลังโหลด, null = ไม่พบ

  useEffect(() => {
    document.title = 'ใบสั่งงาน — Snail Shop'
  }, [])

  useEffect(() => {
    if (!supabase) {
      setJob(null)
      return
    }
    ;(async () => {
      const { data, error } = await supabase.rpc('get_job_by_code', { p_code: code })
      setJob(error || !data ? null : data)
    })()
  }, [code])

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

  // ให้หน้าตาข้อมูลเหมือนฝั่งหลังร้าน จะได้ใช้ตัวคำนวณยอดเดียวกัน
  const j = { ...job, job_items: job.items || [], job_payments: job.payments || [] }
  const t = jobTotals(j)
  const step = statusIdx(job.status)
  const delays = job.delays || []
  const files = job.files || []
  const briefFiles = files.filter((f) => f.kind === 'บรีฟ')
  const workFiles = files.filter((f) => f.kind !== 'บรีฟ')

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
            สั่งงาน {ddmm(job.order_date)} · ส่งภายใน <b style={{ color: 'var(--pink-deep)' }}>{ddmm(job.due_date)}</b>
          </div>
          {delays.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {delays.map((d) => (
                <div key={d.seq} className="jb-small" style={{ fontSize: 13 }}>
                  🔁 เลื่อนครั้งที่ {d.seq}: {ddmm(d.old_date)} → {ddmm(d.new_date)}{d.reason ? ` (${d.reason})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* บรีฟ */}
        {(job.brief || briefFiles.length > 0) && (
          <div className="ord-sec">
            <div className="ord-sec-title">📝 บรีฟงาน</div>
            {job.brief && <div className="ord-line" style={{ whiteSpace: 'pre-wrap' }}>{job.brief}</div>}
            {briefFiles.length > 0 && <Gallery files={briefFiles} />}
          </div>
        )}

        {/* รายการ */}
        <div className="ord-sec">
          <div className="ord-sec-title">🎨 รายการ</div>
          <table className="jb-table">
            <thead>
              <tr>
                <th>ลาย</th>
                <th>ไซส์</th>
                <th className="num">จำนวน</th>
                <th className="num">ราคา</th>
                <th className="num">รวม</th>
              </tr>
            </thead>
            <tbody>
              {j.job_items.map((i, k) => (
                <tr key={k}>
                  <td>{i.design}</td>
                  <td>{i.size}</td>
                  <td className="num">{i.qty}</td>
                  <td className="num">{baht(i.price)}</td>
                  <td className="num">{baht(i.qty * i.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="jb-total"><span>รวม {t.qty} ชุด</span><span>{baht(t.amount)} ฿</span></div>
          {t.anyRecv && (
            <div className="ord-line" style={{ fontSize: 13 }}>
              ร้านรับของแล้ว {t.recvQty} ชุด{t.damaged ? ` · ชำรุด ${t.damaged} ชุด` : ''}
            </div>
          )}
        </div>

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

        {/* เลขพัสดุที่ช่างส่งมา */}
        <div className="ord-sec">
          <div className="ord-sec-title">🚚 ส่งของมาที่ร้าน</div>
          {job.tracking ? (
            <>
              <div className="ord-line">
                เลขพัสดุ{carrierOf(job.tracking) ? ` ${carrierOf(job.tracking)}` : ''}: <b>{job.tracking}</b>
              </div>
              {trackUrlOf(job.tracking) && (
                <a
                  className="ord-btn"
                  href={trackUrlOf(job.tracking)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'block', marginTop: 10, background: 'var(--pink-deep)', color: '#fff' }}
                >
                  เช็กสถานะพัสดุ ({carrierOf(job.tracking)}) ↗
                </a>
              )}
            </>
          ) : (
            <div className="ord-line jb-muted">ยังไม่มีเลขพัสดุ — ส่งของแล้วแจ้งเลขกับร้านได้เลยค่ะ</div>
          )}
        </div>

        {/* รูปงาน */}
        {workFiles.length > 0 && (
          <div className="ord-sec">
            <div className="ord-sec-title">📷 รูปงาน</div>
            <Gallery files={workFiles} />
          </div>
        )}
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
