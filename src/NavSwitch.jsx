import { Link } from 'react-router-dom'
import './jobs.css'

// แถบสลับหน้า: ออเดอร์ลูกค้า ↔ งานช่าง (คนละหน้า คนละตาราง ข้อมูลไม่ปนกัน)
export default function NavSwitch({ active }) {
  return (
    <nav className="nav-switch no-print">
      <Link to="/" className={'nav-tab' + (active === 'orders' ? ' on' : '')}>📦 ออเดอร์ลูกค้า</Link>
      <Link to="/jobs" className={'nav-tab' + (active === 'jobs' ? ' on' : '')}>🧵 งานช่าง</Link>
    </nav>
  )
}
