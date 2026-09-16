import { createClient } from '@supabase/supabase-js'

// อ่านค่าจาก Environment Variables (ตั้งใน Vercel)
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

// ถ้ายังไม่ได้ตั้งค่า env จะเป็น null (แอปยังทำงานแบบ local ได้ ไม่ค้าง)
export const supabase = url && key ? createClient(url, key) : null

// ชื่อตารางใน Supabase
export const TABLE = 'admin_orders'

// ขั้นสถานะออเดอร์ (เรียงตามลำดับ)
export const STATUSES = ['สรุปแล้ว', 'ฝาก', 'แพ็ค', 'ส่งแล้ว']

// สร้างเลขออเดอร์รูปแบบ YYYYMMDD-NNNN
export function genOrderCode(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  const rand = String(Math.floor(1000 + Math.random() * 9000))
  return `${ymd}-${rand}`
}
