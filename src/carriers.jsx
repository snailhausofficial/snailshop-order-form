import { carrierOf } from './SnailOrderForm.jsx'

/* =====================================================================
   ขนส่งที่ช่างใช้ส่งของมาร้าน + ลิงก์เช็กสถานะ
   - Flash / ไปรษณีย์ไทย: เปิดหน้าผลของเลขนั้นเลย (ลิงก์ชุดเดียวกับหน้าลูกค้า)
   - J&T / KEX / SPX: เปิดหน้าเว็บขนส่ง + คัดลอกเลขให้ไปวาง (ยังไม่มีลิงก์ใส่เลขที่ยืนยันได้)
   ===================================================================== */

export const CARRIERS = ['Flash', 'ไปรษณีย์ไทย', 'J&T', 'KEX', 'SPX', 'มาส่งเอง', 'อื่นๆ']

const HOME = {
  'J&T': 'https://www.jtexpress.co.th/',
  KEX: 'https://th.kex-express.com/',
  SPX: 'https://spx.co.th/',
}

const cleanTk = (tk) => (tk || '').replace(/\s/g, '').toUpperCase()

// เดาขนส่งจากรูปแบบเลข (ได้แค่ Flash / ไปรษณีย์ไทย)
export function guessCarrier(tk) {
  const c = carrierOf(cleanTk(tk))
  if (c === 'Flash') return 'Flash'
  if (c.startsWith('ไปรษณีย์ไทย')) return 'ไปรษณีย์ไทย'
  return ''
}

export function trackInfo(tk, carrier) {
  const t = cleanTk(tk)
  const c = carrier || guessCarrier(t)
  if (c === 'มาส่งเอง') return { carrier: c, url: '', direct: false }
  if (!t) return { carrier: c, url: '', direct: false }
  if (c === 'Flash') return { carrier: c, url: 'https://www.flashexpress.co.th/fle/tracking?se=' + encodeURIComponent(t), direct: true }
  if (c === 'ไปรษณีย์ไทย') return { carrier: c, url: 'https://track.thailandpost.co.th/?trackNumber=' + encodeURIComponent(t), direct: true }
  if (HOME[c]) return { carrier: c, url: HOME[c], direct: false }
  return { carrier: c, url: '', direct: false }
}

// ช่างส่งของแล้วหรือยัง (มีเลข หรือเลือก "มาส่งเอง")
export const hasShipped = (job) => !!(job?.tracking || job?.tracking_carrier === 'มาส่งเอง')

export function shipText(job) {
  if (!hasShipped(job)) return ''
  const c = job.tracking_carrier || guessCarrier(job.tracking)
  if (c === 'มาส่งเอง') return 'ช่างมาส่งเอง'
  return [c, job.tracking].filter(Boolean).join(' · ')
}

// ปุ่ม/ลิงก์เช็กสถานะ — เจ้าที่ใส่เลขในลิงก์ไม่ได้ จะคัดลอกเลขให้ก่อนเปิดเว็บ
export function TrackLink({ tk, carrier, className, style, onCopied, children }) {
  const info = trackInfo(tk, carrier)
  if (!info.url) return null
  async function onClick() {
    if (info.direct) return
    try {
      await navigator.clipboard.writeText(cleanTk(tk))
      onCopied && onCopied()
    } catch {}
  }
  return (
    <a className={className} style={style} href={info.url} target="_blank" rel="noreferrer" onClick={onClick}>
      {children || (info.direct ? `เช็กสถานะ (${info.carrier}) ↗` : `คัดลอกเลข + เปิดเว็บ ${info.carrier} ↗`)}
    </a>
  )
}
