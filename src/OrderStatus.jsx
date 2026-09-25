import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase, TABLE, STATUSES } from './supabase'

// LINE OA ของร้าน (ลูกค้ากดสอบถาม)
const SHOP_LINE = 'https://line.me/R/ti/p/@snailshop'

export default function OrderStatus() {
  const { code } = useParams()
  const [order, setOrder] = useState(undefined) // undefined = กำลังโหลด, null = ไม่พบ

  useEffect(() => {
    if (!supabase) {
      setOrder(null)
      return
    }
    ;(async () => {
    const { data, error } = await supabase.rpc('get_order_by_code', { p_code: code })
setOrder(error || !data?.length ? null : data[0])
    })()
  }, [code])

  if (order === undefined) {
    return (
      <div className="ord-wrap">
        <div className="ord-loading">🐌 กำลังโหลด...</div>
      </div>
    )
  }

  if (order === null) {
    return (
      <div className="ord-wrap">
        <div className="ord-card ord-notfound">
          <div className="ord-snail">🐌</div>
          <h2>ไม่พบออเดอร์นี้</h2>
          <p>เลขที่ {code} อาจไม่ถูกต้อง หรือลิงก์หมดอายุ</p>
        </div>
      </div>
    )
  }

  const stepIndex = Math.max(0, STATUSES.indexOf(order.status || STATUSES[0]))

  return (
    <div className="ord-wrap">
      <div className="ord-top">
        <span className="ord-brand">🐌 SnailShop</span>
        <span className="ord-sub">เล็บปลอม Handmade</span>
      </div>

      <div className="ord-card">
        <div className="ord-eyebrow">รายละเอียดออเดอร์</div>
        <h1 className="ord-no">
          เลขที่ <b>{order.code}</b>
        </h1>
        {order.tiktok && <div className="ord-acc">แอคเค้าตต : <b>{order.tiktok}</b></div>}

        {/* แถบสถานะ */}
        <div className="tracker">
          {STATUSES.map((s, i) => {
            const done = i < stepIndex
            const now = i === stepIndex
            return (
              <div key={s} className={'step ' + (done ? 'done' : now ? 'now' : '')}>
                <div className="dot">{done ? '✓' : i + 1}</div>
                <div className="step-label">{s}</div>
                {i < STATUSES.length - 1 && <div className={'bar ' + (i < stepIndex ? 'done' : '')} />}
              </div>
            )
          })}
        </div>
        <div className="status-now">สถานะตอนนี้: <b>{order.status || STATUSES[0]}</b></div>

        {/* รายการ */}
        <div className="ord-sec">
          <div className="ord-sec-title">รายการสั่งทำ</div>
          <div className="ord-item">
            <div className="item-main">
              <span className="item-name">{order.type || 'เล็บปลอม Handmade'}</span>
              {order.note && order.note !== '-' && <span className="item-note">แถม: {order.note}</span>}
            </div>
            <div className="item-qty">{order.qty} ชุด</div>
          </div>
          {order.send_date && <div className="ord-line">📅 กำหนดส่ง: <b>{order.send_date}</b></div>}
          {order.tracking && (
            <div className="ord-line">📦 เลขพัสดุ Flash: <b>{order.tracking}</b></div>
          )}
        </div>

        {/* ที่อยู่ */}
        {(order.name || order.addr || order.phone) && (
          <div className="ord-sec">
            <div className="ord-sec-title">ที่อยู่จัดส่ง</div>
            {order.name && <div className="ord-line"><b>{order.name}</b></div>}
            {order.addr && <div className="ord-line">{order.addr}</div>}
            {order.phone && <div className="ord-line">โทร {order.phone}</div>}
          </div>
        )}

        {/* ปุ่ม */}
        <div className="ord-actions no-print">
          <button className="ord-btn ghost" onClick={() => window.print()}>🖨️ พิมพ์</button>
          <a className="ord-btn line" href={SHOP_LINE} target="_blank" rel="noreferrer">💬 สอบถาม LINE</a>
        </div>
      </div>

      <div className="ord-foot">SnailShop · เล็บปลอม Handmade 🐌</div>
    </div>
  )
}
