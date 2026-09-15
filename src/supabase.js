import { createClient } from '@supabase/supabase-js'

// อ่านค่าจาก Environment Variables (ตั้งใน Vercel)
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

// ถ้ายังไม่ได้ตั้งค่า env จะเป็น null (แอปยังทำงานแบบ local ได้ ไม่ค้าง)
export const supabase = url && key ? createClient(url, key) : null

// ชื่อตารางใน Supabase
export const TABLE = 'admin_orders'
