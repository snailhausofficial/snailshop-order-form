import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import SnailOrderForm from './SnailOrderForm.jsx'
import OrderStatus from './OrderStatus.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SnailOrderForm />} />
        <Route path="/ord/:code" element={<OrderStatus />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
)
