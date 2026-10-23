import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import SnailOrderForm from './SnailOrderForm.jsx'
import OrderStatus from './OrderStatus.jsx'
import ArtisanJobs from './ArtisanJobs.jsx'
import ArtisanJob from './ArtisanJob.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SnailOrderForm />} />
        <Route path="/ord/:code" element={<OrderStatus />} />
        <Route path="/jobs" element={<ArtisanJobs />} />
        <Route path="/job/:code" element={<ArtisanJob />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
)
