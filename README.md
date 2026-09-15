# Snail Rumruay Mai — ฟอร์มกรอกออเดอร์

ฟอร์มให้ลูกน้องกรอกออเดอร์จากแชท LINE OA
- วางข้อความทั้งก้อน → กด "แยกข้อมูลให้" → ระบบเติมช่องอัตโนมัติ
- ตารางออเดอร์สะสม + รวมยอดชุด
- ปุ่มปริ้นใบปะหน้าพัสดุ (1 ออเดอร์/หน้า)

Vite + React (โครงสร้างเดียวกับ snailshop-pos)

## รันในเครื่อง
```bash
npm install
npm run dev
```
เปิด http://localhost:5173

## ขึ้น GitHub
```bash
git init
git add .
git commit -m "Snail order form"
git branch -M main
git remote add origin https://github.com/snailhausofficial/snailshop-order-form.git
git push -u origin main
```

## Deploy บน Vercel
1. เข้า vercel.com → Add New → Project
2. เลือก repo `snailshop-order-form`
3. Framework Preset = **Vite** (Vercel ตรวจให้อัตโนมัติ)
4. กด Deploy — เสร็จ

## หมายเหตุ
ตอนนี้ข้อมูลเก็บชั่วคราวในหน้า (refresh แล้วหาย)
ถ้าจะบันทึกถาวร + ยิง LINE แจ้งเตือน ต่อ Supabase แบบเดียวกับ snailshop-pos ได้
ตัวแยกข้อความอยู่ในฟังก์ชัน `parseMessage()` ใน `src/SnailOrderForm.jsx` — ปรับ regex เพิ่มรูปแบบได้
