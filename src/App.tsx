import { BrowserRouter, Routes, Route } from 'react-router-dom'
import CustomerProofPage from './pages/CustomerProofPage'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import NewProofPage from './pages/NewProofPage'
import ProofDetailPage from './pages/ProofDetailPage'
import NewVersionPage from './pages/NewVersionPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/p/:id" element={<CustomerProofPage />} />

        {/* Authenticated */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<DashboardPage />} />
        <Route path="/proofs/new" element={<NewProofPage />} />
        <Route path="/proofs/:id" element={<ProofDetailPage />} />
        <Route path="/proofs/:id/versions/new" element={<NewVersionPage />} />
      </Routes>
    </BrowserRouter>
  )
}
