import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import RequireAuth from './components/RequireAuth'
import CustomerProofPage from './pages/CustomerProofPage'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import NewProofPage from './pages/NewProofPage'
import ProofDetailPage from './pages/ProofDetailPage'
import NewVersionPage from './pages/NewVersionPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/p/:id" element={<CustomerProofPage />} />
          <Route path="/login" element={<LoginPage />} />

          {/* Authenticated */}
          <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
          <Route path="/proofs/new" element={<RequireAuth><NewProofPage /></RequireAuth>} />
          <Route path="/proofs/:id" element={<RequireAuth><ProofDetailPage /></RequireAuth>} />
          <Route path="/proofs/:id/versions/new" element={<RequireAuth><NewVersionPage /></RequireAuth>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
